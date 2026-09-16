export const config = {
  api: {
    bodyParser: {
      sizeLimit: "8kb",
    },
  },
};

declare const process: { env: Record<string, string | undefined> };

const TELEGRAM_TIMEOUT_MS = 10_000;
const PHONE_MIN_DIGITS = 5;
const FIELD_MAX = 500;
const FORBIDDEN_BODY_KEYS = [
  "token",
  "bot_token",
  "botToken",
  "telegramToken",
  "telegram_bot_token",
  "TELEGRAM_BOT_TOKEN",
  "chat_id",
  "chatId",
  "telegram_chat_id",
  "TELEGRAM_CHAT_ID",
];

interface LeadBody {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  comment?: unknown;
  source?: unknown;
  page?: unknown;
}

interface VercelRequestLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface VercelResponseLike {
  setHeader(name: string, value: string): void;
  status(code: number): VercelResponseLike;
  json(body: unknown): void;
}

function headerValue(headers: VercelRequestLike["headers"], name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return typeof raw === "string" ? raw : "";
}

function clip(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, FIELD_MAX);
}

function digitCount(phone: string): number {
  return (phone.match(/\d/g) ?? []).length;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
}

async function secretsEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function hasForbiddenKeys(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return FORBIDDEN_BODY_KEYS.some((key) => key in (body as Record<string, unknown>));
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatMessage(input: {
  name: string;
  phone: string;
  email: string;
  comment: string;
  source: string;
  page: string;
}): string {
  const when = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  const lines = [
    "🔵 <b>Новая заявка с сайта zasvorf.pro</b>",
    "",
    `<b>Имя:</b> ${escapeHtml(input.name || "не указано")}`,
    `<b>Телефон:</b> ${escapeHtml(input.phone)}`,
    `<b>Email:</b> ${escapeHtml(input.email || "не указан")}`,
  ];
  if (input.comment) {
    lines.push("", "<b>Комментарий:</b>", escapeHtml(input.comment));
  }
  lines.push(
    "",
    `<b>Источник:</b> ${escapeHtml(input.source || "не указан")}`,
    `<b>Страница:</b> ${escapeHtml(input.page || "/")}`,
    `<b>Дата:</b> ${escapeHtml(when)}`,
  );
  return lines.join("\n");
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const expectedSecret = process.env.LEAD_RELAY_SECRET ?? "";
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID ?? "";

  if (!expectedSecret || !botToken || !chatId) {
    console.error("relay: not_configured");
    res.status(500).json({ ok: false, error: "not_configured" });
    return;
  }

  const authorization = headerValue(req.headers, "authorization");
  const provided =
    authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!(await secretsEqual(provided, expectedSecret))) {
    console.error("relay: unauthorized");
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  if (hasForbiddenKeys(req.body)) {
    console.error("relay: forbidden_fields");
    res.status(400).json({ ok: false, error: "invalid_payload" });
    return;
  }

  const payload = (req.body ?? {}) as LeadBody;
  const phone = clip(payload.phone);
  if (digitCount(phone) < PHONE_MIN_DIGITS) {
    res.status(400).json({ ok: false, error: "phone_required" });
    return;
  }

  const name = clip(payload.name);
  const email = clip(payload.email);
  const comment = clip(payload.comment);
  const source = clip(payload.source);
  const page = clip(payload.page);
  const text = formatMessage({ name, phone, email, comment, source, page });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: controller.signal,
    });

    let telegramJson: { ok?: unknown } = {};
    try {
      telegramJson = (await telegramResponse.json()) as { ok?: unknown };
    } catch {
      console.error("relay: telegram_invalid_json", {
        source,
        status: telegramResponse.status,
        phone: maskPhone(phone),
      });
      res.status(502).json({ ok: false, error: "telegram_failed" });
      return;
    }

    if (!telegramResponse.ok || telegramJson.ok !== true) {
      console.error("relay: telegram_failed", {
        source,
        status: telegramResponse.status,
        phone: maskPhone(phone),
      });
      res.status(502).json({ ok: false, error: "telegram_failed" });
      return;
    }

    console.info("relay: delivered", {
      source,
      status: 200,
      phone: maskPhone(phone),
      at: new Date().toISOString(),
    });
    res.status(200).json({ ok: true });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    console.error(timedOut ? "relay: telegram_timeout" : "relay: telegram_unreachable", {
      source,
      phone: maskPhone(phone),
    });
    res.status(502).json({ ok: false, error: timedOut ? "telegram_timeout" : "telegram_unreachable" });
  } finally {
    clearTimeout(timer);
  }
}
