import type { Api } from "grammy";

// ── KV helpers ────────────────────────────────────────────────────────────────

const LOG_KEY = (chatId: number) => `log_channel:${chatId}`;

export async function getLogChannel(
  kv: KVNamespace,
  chatId: number
): Promise<number | null> {
  const val = await kv.get(LOG_KEY(chatId));
  return val ? parseInt(val, 10) : null;
}

export async function setLogChannel(
  kv: KVNamespace,
  chatId: number,
  channelId: number
): Promise<void> {
  await kv.put(LOG_KEY(chatId), String(channelId));
}

export async function removeLogChannel(
  kv: KVNamespace,
  chatId: number
): Promise<void> {
  await kv.delete(LOG_KEY(chatId));
}

// ── Formatting ─────────────────────────────────────────────────────────────────

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function ulink(id: number, name: string): string {
  return `<a href="tg://user?id=${id}">${esc(name)}</a>`;
}

function utcNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// ── Sender ─────────────────────────────────────────────────────────────────────

/**
 * Sends a moderation log entry to the configured log channel for `chatId`.
 * Silently does nothing if no channel is configured.
 */
export async function sendLog(
  api: Api,
  kv: KVNamespace,
  chatId: number,
  chatTitle: string,
  body: string
): Promise<void> {
  const channelId = await getLogChannel(kv, chatId);
  if (!channelId) return;

  const message =
    body +
    `\n\n<code>──────────────────</code>\n` +
    `🏠 <b>${esc(chatTitle)}</b>\n` +
    `🆔 <code>${chatId}</code>  🕐 <code>${utcNow()}</code>`;

  try {
    await api.sendMessage(channelId, message, { parse_mode: "HTML" });
  } catch (err) {
    console.error(`[logger] channel ${channelId}: ${String(err)}`);
  }
}
