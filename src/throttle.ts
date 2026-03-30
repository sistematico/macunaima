/**
 * Per-user Gemini call throttle backed by KV TTL.
 *
 * Once `setThrottle` is called for a (chatId, userId) pair, all subsequent
 * `isThrottled` checks return true until the TTL expires — meaning Gemini
 * will NOT be called again for that user within the window.
 *
 * This is the primary mechanism to stay within the free-tier rate limit
 * (gemini-1.5-flash: 15 RPM / 1500 RPD).
 */

const KEY = (chatId: number, userId: number) =>
  `gemini_throttle:${chatId}:${userId}`;

export async function isThrottled(
  kv: KVNamespace,
  chatId: number,
  userId: number
): Promise<boolean> {
  return (await kv.get(KEY(chatId, userId))) !== null;
}

export async function setThrottle(
  kv: KVNamespace,
  chatId: number,
  userId: number,
  ttlSeconds: number
): Promise<void> {
  await kv.put(KEY(chatId, userId), "1", { expirationTtl: ttlSeconds });
}
