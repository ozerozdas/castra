import type { Context, Env, MiddlewareHandler } from "hono";
import { problemResponse } from "./problem.js";

/** The part of the Workers Rate Limiting binding (`RateLimit`) that {@link rateLimitWrites} uses. */
export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

let warnedMissingBinding = false;

/**
 * Limits every non-read request (sign-in, sign-up, `/mcp`, table writes) per client IP with the Workers Rate Limiting
 * binding (ADR 0072). Over the limit it answers `429` problem `rate_limited` with `Retry-After`.
 *
 * The key is `<host>:<cf-connecting-ip>`. Requests without that header (only outside Cloudflare, e.g. tests) or
 * without a binding are not limited. A write from Cloudflare without a binding logs one warning per isolate (ADR 0077).
 *
 * @param getLimiter returns the binding, e.g. `(c) => c.env.RATE_LIMITER`.
 * @param retryAfterSeconds the `Retry-After` value; match the binding's `period`. Default 60.
 */
export function rateLimitWrites<E extends Env = Env>(
  getLimiter: (c: Context<E>) => RateLimiterLike | undefined,
  retryAfterSeconds = 60,
): MiddlewareHandler<E> {
  return async (c, next) => {
    const ip = c.req.header("cf-connecting-ip");
    const write = !READS.has(c.req.method.toUpperCase()) && ip;
    const limiter = write ? getLimiter(c) : undefined;
    if (write && !limiter && !warnedMissingBinding) {
      warnedMissingBinding = true;
      console.warn(
        "castra: rateLimitWrites has no binding, so writes are not rate limited. Add the RATE_LIMITER entry to `ratelimits` in wrangler.jsonc (docs/rate-limiting.md).",
      );
    }
    if (limiter && !(await limiter.limit({ key: `${new URL(c.req.url).host}:${ip}` })).success) {
      const res = problemResponse(429, "Too many requests from this address. Try again later.", "rate_limited");
      res.headers.set("retry-after", String(retryAfterSeconds));
      return res;
    }
    await next();
  };
}
