export const config = {
  api: {
    bodyParser: {
      sizeLimit: "32kb",
    },
  },
};

declare const process: { env: Record<string, string | undefined> };

const TEXT_MAX = 2000;

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

async function tokenMatches(provided: string, expected: string): Promise<boolean> {
  if (!provided || !expected) {
    return false;
  }
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

function replyTarget(): string | undefined {
  const url = process.env.CHAT_REPLY_URL ?? "";
  if (!url.startsWith("https://")) {
    return undefined;
  }
  return url;
}

// Telegram вызывает этот адрес после setWebhook. Файлы Vercel между запросами
// не хранятся, поэтому связь message_id с диалогом живёт на VPS.
export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false });
    return;
  }

  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const provided = headerValue(req.headers, "x-telegram-bot-api-secret-token");
  if (!(await tokenMatches(provided, webhookSecret))) {
    console.error("relay(webhook): unauthorized");
    res.status(401).json({ ok: false });
    return;
  }

  const configuredChat = String(process.env.TELEGRAM_CHAT_ID ?? "");
  const relaySecret = process.env.LEAD_RELAY_SECRET ?? "";
  const update = (req.body ?? {}) as {
    update_id?: unknown;
    message?: {
      message_id?: unknown;
      text?: unknown;
      from?: { is_bot?: unknown };
      chat?: { id?: unknown };
      reply_to_message?: { message_id?: unknown; text?: unknown };
    };
  };
  const message = update.message;
  const text = typeof message?.text === "string" ? message.text.trim().slice(0, TEXT_MAX) : "";
  const replyTo = message?.reply_to_message?.message_id;
  const replyToText = typeof message?.reply_to_message?.text === "string" ? message.reply_to_message.text.slice(0, 4500) : "";
  const chatId = message?.chat?.id;
  const updateId = update.update_id;
  const messageId = message?.message_id;

  const isReply = Boolean(text) && message?.from?.is_bot !== true && replyTo != null;
  if (!isReply) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  const target = replyTarget();
  if (!configuredChat || !relaySecret || !target) {
    console.error("relay(webhook): not_configured");
    res.status(500).json({ ok: false });
    return;
  }
  if (String(chatId) !== configuredChat) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${relaySecret}`,
      },
      body: JSON.stringify({
        updateId: String(updateId),
        replyToMessageId: String(replyTo),
        messageId: String(messageId),
        text,
        replyToText,
      }),
      signal: controller.signal,
    });

    if (response.status === 409) {
      res.status(500).json({ ok: false, error: "retry" });
      return;
    }
    if (!response.ok) {
      console.error("relay(webhook): vps_rejected", { status: response.status });
      res.status(502).json({ ok: false });
      return;
    }
    res.status(200).json({ ok: true });
  } catch {
    console.error("relay(webhook): vps_unreachable");
    res.status(502).json({ ok: false });
  } finally {
    clearTimeout(timer);
  }
}
