import type { Context, Env, MiddlewareHandler } from "hono";
import { problemResponse } from "./problem.js";

/** The part of the Workers Rate Limiting binding (`RateLimit`) that {@link rateLimitWrites} uses. */
export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Limits every non-read request (sign-in, sign-up, `/mcp`, table writes) per client IP with the Workers Rate Limiting
 * binding (ADR 0072). Over the limit it answers `429` problem `rate_limited` with `Retry-After`.
 *
 * The key is `<host>:<cf-connecting-ip>`. Requests without that header (only outside Cloudflare, e.g. tests) or
 * without a binding are not limited.
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
    const limiter = READS.has(c.req.method.toUpperCase()) || !ip ? undefined : getLimiter(c);
    if (limiter && !(await limiter.limit({ key: `${new URL(c.req.url).host}:${ip}` })).success) {
      const res = problemResponse(429, "Too many requests from this address. Try again later.", "rate_limited");
      res.headers.set("retry-after", String(retryAfterSeconds));
      return res;
    }
    await next();
  };
}
