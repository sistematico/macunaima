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

const MIN_KV_TTL_SECONDS = 60;

function normalizeKvTtl(seconds: number): number {
  return Math.max(MIN_KV_TTL_SECONDS, Math.ceil(seconds));
}

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
  await kv.put(KEY(chatId, userId), "1", {
    expirationTtl: normalizeKvTtl(ttlSeconds),
  });
}

const WINDOW_KEY = (scope: string, bucket: number) =>
  `rate_limit:${scope}:${bucket}`;

/**
 * Fixed-window limiter backed by KV.
 * Returns true when request is allowed, false when the limit has been exceeded.
 */
export async function allowFixedWindow(
  kv: KVNamespace,
  scope: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSeconds / windowSeconds);
  const key = WINDOW_KEY(scope, bucket);

  const current = parseInt((await kv.get(key)) ?? "0", 10);
  if (current >= limit) return false;

  await kv.put(key, String(current + 1), {
    expirationTtl: normalizeKvTtl(windowSeconds + 5),
  });
  return true;
}

export async function reserveGeminiChatSlot(
  kv: KVNamespace,
  chatId: number,
  limitPerMinute: number
): Promise<boolean> {
  return allowFixedWindow(kv, `gemini_chat:${chatId}`, limitPerMinute, 60);
}
