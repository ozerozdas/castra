import type { Context, Env, MiddlewareHandler } from "hono";
import { problemResponse } from "./problem.js";

/** The part of the Workers Rate Limiting binding (`RateLimit`) that {@link rateLimitWrites} uses. */
export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

const warned = new Set<string>();

/** Options of {@link rateLimitWrites}. */
export interface RateLimitWritesOptions<E extends Env = Env> {
  /** The `Retry-After` value; match the binding's `period`. Default 60. */
  retryAfterSeconds?: number;
  /**
   * Keys the limit by something other than the client IP, e.g. `(c) => c.get("ctx").user?.id` after the request
   * context is set. `undefined` falls back to the IP (ADR 0078).
   */
  key?: (c: Context<E>) => string | undefined;
  /** Binding name used in the missing-binding warning. Default `RATE_LIMITER`. */
  binding?: string;
}

/**
 * Limits every non-read request (sign-in, sign-up, `/mcp`, table writes) with the Workers Rate Limiting binding
 * (ADR 0072). Over the limit it answers `429` problem `rate_limited` with `Retry-After`.
 *
 * The key is `<host>:<cf-connecting-ip>`, or `<host>:id:<key>` when `options.key` returns one (ADR 0078). Requests
 * without `cf-connecting-ip` (only outside Cloudflare, e.g. tests) or without a binding are not limited. A write from
 * Cloudflare without a binding logs one warning per binding name and isolate (ADR 0077).
 *
 * @param getLimiter returns the binding, e.g. `(c) => c.env.RATE_LIMITER`.
 * @param options `retryAfterSeconds` (or that number alone), `key`, `binding`.
 */
export function rateLimitWrites<E extends Env = Env>(
  getLimiter: (c: Context<E>) => RateLimiterLike | undefined,
  options: number | RateLimitWritesOptions<E> = {},
): MiddlewareHandler<E> {
  const { retryAfterSeconds = 60, key, binding = "RATE_LIMITER" } = typeof options === "number" ? { retryAfterSeconds: options } : options;
  return async (c, next) => {
    const ip = c.req.header("cf-connecting-ip");
    const write = !READS.has(c.req.method.toUpperCase()) && ip;
    const limiter = write ? getLimiter(c) : undefined;
    if (write && !limiter && !warned.has(binding)) {
      warned.add(binding);
      console.warn(
        `castra: no ${binding} binding, so these writes are not rate limited. Add it to \`ratelimits\` in wrangler.jsonc (docs/rate-limiting.md).`,
      );
    }
    const id = limiter ? key?.(c) : undefined;
    if (limiter && !(await limiter.limit({ key: `${new URL(c.req.url).host}:${id === undefined ? ip : `id:${id}`}` })).success) {
      const res = problemResponse(429, "Too many requests from this address. Try again later.", "rate_limited");
      res.headers.set("retry-after", String(retryAfterSeconds));
      return res;
    }
    await next();
  };
}
