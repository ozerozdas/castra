import { problemBody, type CastraContext } from "@castra-kit/core";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { anonymousContext, resolveContext } from "./context.js";
import {
  createAuth,
  DEFAULT_AUTH_BASE_PATH,
  type AuthEnv,
  type CastraAuth,
  type CastraAuthOptions,
} from "./create-auth.js";

/** Hono variables set by {@link castraContext}. */
export interface CastraAuthVariables {
  ctx: CastraContext;
  auth: CastraAuth;
}

/** Hono environment for apps using the auth helpers. */
export interface CastraAuthHonoEnv<E extends AuthEnv = AuthEnv> {
  Bindings: E;
  Variables: CastraAuthVariables;
}

/** RFC 9457 problem details body. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
}

/** Returns an `application/problem+json` response. */
export function problem(status: number, title: string, detail: string, type = "about:blank"): Response {
  const body: ProblemDetails = { type, title, status, detail };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

const instances = new WeakMap<AuthEnv, WeakMap<CastraAuthOptions, CastraAuth>>();

/** Returns a Better Auth instance for `env`, cached per env object and options. */
export function getAuth(env: AuthEnv, options: CastraAuthOptions): CastraAuth {
  let byOptions = instances.get(env);
  if (!byOptions) {
    byOptions = new WeakMap();
    instances.set(env, byOptions);
  }
  let auth = byOptions.get(options);
  if (!auth) {
    auth = createAuth(env, options);
    byOptions.set(options, auth);
  }
  return auth;
}

/**
 * Rewrites a Better Auth error response (status >= 400) as `application/problem+json` (ADR 0073).
 * Problem type `auth_error`, or `rate_limited` for 429. Better Auth's `code` and `message` stay as
 * extension members so its client SDK still reads them. 5xx bodies are replaced by a generic detail.
 * Headers (Set-Cookie, Retry-After) are kept. Success responses pass through untouched.
 */
export async function authProblem(res: Response): Promise<Response> {
  if (res.status < 400) return res;
  let upstream: { code?: unknown; message?: unknown } = {};
  if (res.status < 500 && /json/i.test(res.headers.get("content-type") ?? "")) {
    upstream = ((await res.json().catch(() => null)) as typeof upstream | null) ?? {};
  }
  const code = typeof upstream.code === "string" ? upstream.code : undefined;
  const message = typeof upstream.message === "string" && upstream.message ? upstream.message : undefined;
  const detail =
    res.status >= 500 ? "The authentication service failed. Try again later." : message ?? "The authentication request failed.";
  const base = res.status === 429 ? problemBody(429, detail, "rate_limited") : problemBody(res.status, detail, "auth_error");
  const body = { ...base, code, message: detail };
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/problem+json");
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status: res.status, headers });
}

/**
 * Mounts the Better Auth handler at `${basePath}/*` (default `/api/auth/*`) for GET and POST.
 * Errors are returned as `application/problem+json` (see {@link authProblem}).
 */
export function authRoutes<E extends CastraAuthHonoEnv>(app: Hono<E>, options: CastraAuthOptions): Hono<E> {
  const basePath = options.basePath ?? DEFAULT_AUTH_BASE_PATH;
  app.on(["GET", "POST"], `${basePath}/*`, async (c) => authProblem(await getAuth(c.env, options).handler(c.req.raw)));
  return app;
}

/**
 * Middleware that resolves the request identity and sets `c.get("ctx")` (and `c.get("auth")`).
 */
export function castraContext<E extends CastraAuthHonoEnv>(options: CastraAuthOptions): MiddlewareHandler<E> {
  return async (c, next) => {
    const auth = getAuth(c.env, options);
    c.set("auth", auth);
    c.set("ctx", await resolveContext(c.req.raw, { auth, db: c.env.DB, roles: options.roles }));
    await next();
  };
}

function contextOf(c: Context): CastraContext {
  return (c.get("ctx") as CastraContext | undefined) ?? anonymousContext(c.req.raw);
}

/**
 * Allows the request when the caller holds at least one of `roles`.
 * Anonymous → 401, authenticated without a matching role → 403 (`application/problem+json`).
 * Requires {@link castraContext} earlier in the chain; without it every caller is anonymous.
 */
export function requireRole<E extends CastraAuthHonoEnv>(...roles: string[]): MiddlewareHandler<E> {
  if (roles.length === 0) throw new Error("requireRole() needs at least one role");
  return async (c, next) => {
    const ctx = contextOf(c);
    if (!ctx.user) return problem(401, "Unauthorized", "Authentication required.");
    if (!roles.some((r) => ctx.roles.includes(r))) {
      return problem(403, "Forbidden", `Requires one of the roles: ${roles.join(", ")}.`);
    }
    await next();
  };
}
