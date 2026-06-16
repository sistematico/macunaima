/**
 * Extracts the recommended retry delay (in ms) from a Google GenAI API error.
 *
 * Supports both SDK formats:
 *  - Old (@google/generative-ai): err.errorDetails[]
 *  - New (@google/genai):         err.message contains JSON with error.details[]
 */
function extractRetryDelayMs(err: unknown): number | null {
  if (!(err instanceof Error)) return null;

  // New SDK: ApiError — status is a number, message contains the JSON body
  const anyErr = err as unknown as Record<string, unknown>;

  // Try old SDK format first (err.errorDetails)
  const details = anyErr["errorDetails"];
  if (Array.isArray(details)) {
    for (const d of details as Record<string, unknown>[]) {
      if (d["@type"] === "type.googleapis.com/google.rpc.RetryInfo") {
        const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d["retryDelay"] ?? ""));
        if (m) return Math.ceil(parseFloat(m[1]!) * 1000);
      }
    }
  }

  // New SDK format: parse delay from JSON embedded in message
  try {
    const parsed = JSON.parse(err.message) as {
      error?: { details?: { "@type"?: string; retryDelay?: string }[] };
    };
    for (const d of parsed?.error?.details ?? []) {
      if (d["@type"] === "type.googleapis.com/google.rpc.RetryInfo") {
        const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay ?? "");
        if (m) return Math.ceil(parseFloat(m[1]!) * 1000);
      }
    }
  } catch { /* message wasn't JSON */ }

  return null;
}

/**
 * Returns true for transient rate-limit errors (HTTP 429, RPM exceeded).
 * Returns false for permanent quota exhaustion (RESOURCE_EXHAUSTED with
 * daily/monthly limits) — those should NOT be retried.
 */
function isRetryableRateLimit(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const anyErr = err as unknown as Record<string, unknown>;

  // New SDK: ApiError has numeric .status
  const httpStatus = typeof anyErr["status"] === "number" ? anyErr["status"] : null;

  // If HTTP status is not 429, not a rate limit error
  if (httpStatus !== null && httpStatus !== 429) return false;

  // If message doesn't mention 429, not a rate limit error
  if (httpStatus === null && !err.message.includes("429")) return false;

  // RESOURCE_EXHAUSTED with limit:0 means the free-tier quota is depleted
  // for the day / billing period — retrying won't help.
  if (err.message.includes("RESOURCE_EXHAUSTED") && err.message.includes("limit: 0")) {
    return false;
  }

  return true;
}

/**
 * Retries `fn` once on a transient 429 rate-limit error, waiting the delay
 * suggested by the API (or `fallbackDelayMs` if none is provided).
 *
 * Never retries on permanent quota exhaustion (RESOURCE_EXHAUSTED / limit:0).
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
    if (!isRetryableRateLimit(err)) throw err;

    const delay = extractRetryDelayMs(err) ?? fallbackDelayMs;
    if (delay > maxWaitMs) throw err; // not worth waiting, let the caller handle it

    await new Promise((r) => setTimeout(r, delay));
    return fn(); // one retry
  }
}
