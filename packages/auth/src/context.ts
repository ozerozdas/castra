import type { CastraContext } from "castra";
import { API_KEY_PREFIX, verifyApiKey } from "./api-keys.js";
import type { CastraAuth } from "./create-auth.js";
import { createAuthDb, type AuthDbInput } from "./db.js";
import { getRoles } from "./roles.js";

/** Dependencies for {@link resolveContext}. */
export interface ResolveContextDeps {
  /** Better Auth instance (from `createAuth`). */
  auth: CastraAuth;
  /** D1 binding or Kysely instance holding the auth tables. */
  db: AuthDbInput;
  /** Configured role list. Grants outside it are ignored. */
  roles: readonly string[];
  /** Clock override for tests. */
  now?: Date;
}

/** Header carrying an API key as an alternative to `Authorization: Bearer castra_ak_...`. */
export const API_KEY_HEADER = "x-api-key";

function requestInfo(request: Request): NonNullable<CastraContext["request"]> {
  return { method: request.method, url: request.url, headers: request.headers };
}

/** An anonymous context for `request` (no user, no roles). */
export function anonymousContext(request: Request | null): CastraContext {
  return {
    user: null,
    roles: [],
    session: null,
    request: request ? requestInfo(request) : null,
    via: "anonymous",
  };
}

/**
 * Extracts an API key from `x-api-key` or `Authorization: Bearer castra_ak_...`.
 * Returns `undefined` when the request does not present an API key at all.
 */
function presentedApiKey(headers: Headers): string | undefined {
  const header = headers.get(API_KEY_HEADER);
  if (header !== null) return header.trim();
  const authorization = headers.get("authorization");
  if (authorization && /^bearer\s+/i.test(authorization)) {
    const token = authorization.replace(/^bearer\s+/i, "").trim();
    if (token.startsWith(API_KEY_PREFIX)) return token;
  }
  return undefined;
}

/**
 * Builds the request {@link CastraContext}.
 *
 * - API key (`x-api-key` or `Authorization: Bearer castra_ak_...`) → `via: "apiKey"`. A presented but
 *   invalid, revoked or expired key yields an anonymous context; it never falls back to the session.
 * - Better Auth session (cookie, or bearer session token) → `via: "session"`, validated against D1
 *   on every call (no cookie cache, no KV).
 * - Otherwise anonymous.
 *
 * Roles always come from `_castra_roles`, never from the client.
 */
export async function resolveContext(request: Request, deps: ResolveContextDeps): Promise<CastraContext> {
  const db = createAuthDb(deps.db);
  const apiKey = presentedApiKey(request.headers);

  if (apiKey !== undefined) {
    const verified = await verifyApiKey(db, apiKey, deps.now);
    if (!verified) return anonymousContext(request);
    const user = await db
      .selectFrom("user")
      .select(["id", "email", "name"])
      .where("id", "=", verified.userId)
      .executeTakeFirst();
    if (!user) return anonymousContext(request);
    const userRoles = await getRoles(db, user.id, deps.roles);
    const roles = verified.roles === null ? userRoles : userRoles.filter((r) => verified.roles!.includes(r));
    return {
      user: { id: user.id, email: user.email, name: user.name },
      roles,
      session: null,
      request: requestInfo(request),
      via: "apiKey",
    };
  }

  let result: Awaited<ReturnType<CastraAuth["api"]["getSession"]>>;
  try {
    result = await deps.auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
  } catch {
    return anonymousContext(request);
  }
  if (!result) return anonymousContext(request);

  const expiresAt = new Date(result.session.expiresAt);
  if (!(expiresAt.getTime() > (deps.now ?? new Date()).getTime())) return anonymousContext(request);

  return {
    user: { id: result.user.id, email: result.user.email, name: result.user.name },
    roles: await getRoles(db, result.user.id, deps.roles),
    session: { id: result.session.id, expiresAt },
    request: requestInfo(request),
    via: "session",
  };
}
