import type { Api } from "grammy";

// ── KV helpers ────────────────────────────────────────────────────────────────

const LOG_KEY = (chatId: number) => `log_channel:${chatId}`;
const GLOBAL_LOG_KEY = "global_log_channel";

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

export async function getGlobalLogChannel(
  kv: KVNamespace
): Promise<number | null> {
  const val = await kv.get(GLOBAL_LOG_KEY);
  return val ? parseInt(val, 10) : null;
}

export async function setGlobalLogChannel(
  kv: KVNamespace,
  channelId: number
): Promise<void> {
  await kv.put(GLOBAL_LOG_KEY, String(channelId));
}

export async function removeGlobalLogChannel(
  kv: KVNamespace
): Promise<void> {
  await kv.delete(GLOBAL_LOG_KEY);
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
 * Sends a moderation log entry to:
 *   1. The per-group log channel configured for `chatId` (if any).
 *   2. The global log channel (if any), provided it differs from the group channel.
 *
 * Both sends happen in parallel — no additional worker invocation is created.
 */
export async function sendLog(
  api: Api,
  kv: KVNamespace,
  chatId: number,
  chatTitle: string,
  body: string
): Promise<void> {
  const [groupChannelId, globalChannelId] = await Promise.all([
    getLogChannel(kv, chatId),
    getGlobalLogChannel(kv),
  ]);

  if (!groupChannelId && !globalChannelId) return;

  const message =
    body +
    `\n\n<code>──────────────────</code>\n` +
    `🏠 <b>${esc(chatTitle)}</b>\n` +
    `🆔 <code>${chatId}</code>  🕐 <code>${utcNow()}</code>`;

  const sends: Promise<unknown>[] = [];

  if (groupChannelId) {
    sends.push(
      api
        .sendMessage(groupChannelId, message, { parse_mode: "HTML" })
        .catch((err) => console.error(`[logger] group channel ${groupChannelId}: ${String(err)}`))
    );
  }

  // Only send to global if it's a different channel (avoid duplicate messages)
  if (globalChannelId && globalChannelId !== groupChannelId) {
    sends.push(
      api
        .sendMessage(globalChannelId, message, { parse_mode: "HTML" })
        .catch((err) => console.error(`[logger] global channel ${globalChannelId}: ${String(err)}`))
    );
  }

  await Promise.all(sends);
}
