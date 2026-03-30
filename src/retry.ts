/**
 * Extracts the recommended retry delay (in ms) from a Google Generative AI
 * 429 error response. Returns null if not present or not parseable.
 */
function extractRetryDelayMs(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const anyErr = err as unknown as Record<string, unknown>;
  const details = anyErr["errorDetails"];
  if (!Array.isArray(details)) return null;

  for (const d of details as Record<string, unknown>[]) {
    if (d["@type"] === "type.googleapis.com/google.rpc.RetryInfo") {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d["retryDelay"] ?? ""));
      if (m) return Math.ceil(parseFloat(m[1]!) * 1000);
    }
  }
  return null;
}

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const anyErr = err as unknown as Record<string, unknown>;
  const status = anyErr["status"];
  return status === 429 || err.message.includes("429");
}

/**
 * Retries `fn` once on a 429 rate-limit error, waiting the delay suggested
 * by the API (or `fallbackDelayMs` if none is provided).
 *
 * Skips the retry if the suggested delay exceeds `maxWaitMs` to avoid
 * timing out inside a Cloudflare Worker (hard limit: 30 s on the free plan).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  fallbackDelayMs = 7_000,
  maxWaitMs = 15_000
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRateLimitError(err)) throw err;

    const delay = extractRetryDelayMs(err) ?? fallbackDelayMs;
    if (delay > maxWaitMs) throw err; // not worth waiting, let the caller handle it

    await new Promise((r) => setTimeout(r, delay));
    return fn(); // one retry
  }
}
