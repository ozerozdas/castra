# Rate limiting

New projects limit **writes** per client IP out of the box ([ADR 0072](adr/0072-rate-limit-binding.md)). This works on
`workers.dev` too, where WAF rules do not apply.

| What | Limited by default | How |
| --- | --- | --- |
| Sign-in, sign-up and other `POST /api/auth/*` | yes, 10/min | `AUTH_RATE_LIMITER` binding, then `RATE_LIMITER` too ([ADR 0078](adr/0078-auth-bucket-and-rate-limit-key.md)) |
| `/mcp` | yes, 60/min | `RATE_LIMITER` binding |
| Table writes (`POST`, `PATCH`, `DELETE /api/*`) and custom routes | yes, 60/min | `RATE_LIMITER` binding |
| Reads (`GET`) | no | WAF rule on a custom domain (below), or cache |

Over the limit the API answers `429` with the problem type
[`rate_limited`](https://castra.mehmetozer.dev/problems/rate_limited) and a `Retry-After` header.

## The default

`wrangler.jsonc`:

```jsonc
"ratelimits": [
  { "name": "RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } },
  { "name": "AUTH_RATE_LIMITER", "namespace_id": "1002", "simple": { "limit": 10, "period": 60 } }
]
```

Use a different `namespace_id` per binding, or the two share counters.

`createCastraApp` (from `@castra-kit/app`) applies `rateLimitWrites` over that binding before every other route.
Without the binding it logs one warning per isolate and does not limit. `rateLimit: false` turns it off.

- 60 writes per 60 seconds per IP address. `period` can only be `10` or `60`. If you change it, pass the same number as
  `rateLimit: { retryAfterSeconds }` (`Retry-After`).
- Counters are kept per Cloudflare location and are approximate. This stops scripts and brute force; it is not exact
  accounting.
- The key is `<host>:<client IP>`, so several apps on one account can use the same `namespace_id`.
- Many users behind one address (an office, a carrier NAT) share a budget. Raise `limit` if real users see 429s.
- Requests without `cf-connecting-ip` are not limited. Outside tests this does not happen: Cloudflare sets the header and
  clients cannot override it.

## Per user instead of per IP

Users behind one address share the IP budget. To key table writes and custom routes by user once they are signed in:

```ts
export default createCastraApp<Env>({
  // ...
  rateLimit: { key: (c) => c.get("ctx").user?.id },
});
```

Anonymous requests still fall back to the IP. `/mcp` and `/api/auth/*` stay keyed by IP. With `key`, the general limit
runs after the session lookup instead of before it.

## Projects created before 0.1.2

Update the `@castra-kit/*` packages, then add the `ratelimits` block to `wrangler.jsonc`, `RATE_LIMITER?: RateLimiterLike`
to `Env`, and the `app.use(...)` line above as the first middleware. Redeploy.

## Reads, on a custom domain

WAF rate limiting rules run before the Worker but only for traffic through your zone (a custom domain or route), not
`workers.dev`. In the dashboard: **Security → WAF → Rate limiting rules → Create rule**.

- **If incoming requests match:** `URI Path` starts with `/api/` (add `and Request Method equals GET` to cover only reads).
- **With the same characteristics:** IP.
- **When rate exceeds:** for example 300 requests per 10 seconds; available periods and rule counts depend on the plan.
- **Then take action:** Block, for 10 seconds.

The REST router also has `hooks.beforeRequest` for app-specific limits, for example per user or per API key.
