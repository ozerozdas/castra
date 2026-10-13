/**
 * `@castra-kit/app`: the Castra Worker app in one call (ADR 0077). Projects keep only app-specific code in
 * `src/index.ts`; middleware added by a release ships with a package bump.
 */
import { authRoutes, castraContext, DEFAULT_AUTH_BASE_PATH, type AuthEnv, type CastraAuthOptions, type CastraAuthVariables } from "@castra-kit/auth";
import {
  createPolicyEngine,
  createRestRouter,
  rateLimitWrites,
  withProblemHandlers,
  type CastraConfig,
  type PolicyEngine,
  type RateLimiterLike,
  type SchemaSnapshot,
} from "@castra-kit/core";
import { createMcpRoute, type AuditOptions } from "@castra-kit/mcp";
import { Hono, type Context } from "hono";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

export type { RateLimiterLike } from "@castra-kit/core";

export const name = "@castra-kit/app";

/** Bindings `createCastraApp` reads. Extend it with the app's own bindings. */
export interface CastraBindings extends AuthEnv {
  DB: D1Database;
  /** Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc, ADR 0072). */
  RATE_LIMITER?: RateLimiterLike;
  /** Tighter bucket for `/api/auth/*` writes such as sign-in and sign-up, on top of `RATE_LIMITER` (ADR 0078). */
  AUTH_RATE_LIMITER?: RateLimiterLike;
}

/** Hono environment of the app: the bindings plus `ctx` / `auth` set by the request context. */
export interface CastraAppEnv<B extends CastraBindings = CastraBindings> {
  Bindings: B;
  Variables: CastraAuthVariables;
}

/** Options of {@link createCastraApp}. */
export interface CastraAppOptions<B extends CastraBindings = CastraBindings> {
  config: CastraConfig;
  /** The committed schema snapshot (`castra generate`). */
  snapshot: SchemaSnapshot;
  /** Shared by REST and MCP. Default: built from `config` and `snapshot`. */
  engine?: PolicyEngine;
  /** Auth options. Default `{ roles: config.roles }`. */
  auth?: CastraAuthOptions;
  /** `info` of `/openapi.json` and the welcome route. */
  openapi?: { title?: string; version?: string };
  /**
   * Write limits (ADRs 0072, 0078). `false` turns them off. `key` keys the general limit by something other than
   * the client IP once the request context is set, e.g. `(c) => c.get("ctx").user?.id`; `undefined` falls back to
   * the IP. Auth routes and `/mcp` are always keyed by IP.
   */
  rateLimit?: false | { retryAfterSeconds?: number; key?: (c: Context<CastraAppEnv<B>>) => string | undefined };
  /** `false` disables `/mcp`; otherwise configure audit redaction and opt-in retention. */
  mcp?: false | { audit?: AuditOptions };
  /** Runs right after the problem handlers, before everything else (CORS, logging). */
  before?: (app: Hono<CastraAppEnv<B>>) => void;
  /** Custom routes. Mounted after the request context (so `c.get("ctx")` is set) and before the table routes. */
  routes?: (app: Hono<CastraAppEnv<B>>) => void;
}

// One Kysely instance per D1 binding object.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbs = new WeakMap<D1Database, Kysely<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function kyselyFor(d1: D1Database): Kysely<any> {
  let db = dbs.get(d1);
  if (!db) {
    db = new Kysely({ dialect: new D1Dialect({ database: d1 }) });
    dbs.set(d1, db);
  }
  return db;
}

/**
 * Builds the Worker app, in order: problem+json handlers, `before`, the write rate limits, `GET /health`, `/mcp`,
 * Better Auth under `/api/auth/*`, the request context (then the keyed write limit, if any), `GET /me`, `routes`,
 * then the REST router
 * (`/`, `/openapi.json`, `/api/<table>`).
 */
export function createCastraApp<B extends CastraBindings = CastraBindings>(options: CastraAppOptions<B>): Hono<CastraAppEnv<B>> {
  type E = CastraAppEnv<B>;
  const { config, snapshot } = options;
  const engine = options.engine ?? createPolicyEngine({ config, snapshot });
  const auth = options.auth ?? { roles: config.roles };

  // Hono's route() does not carry notFound/onError over: set the problem+json fallbacks on the root app.
  const app = withProblemHandlers(new Hono<E>());
  options.before?.(app);

  const rl = options.rateLimit === false ? undefined : (options.rateLimit ?? {});
  const limit = (binding: "RATE_LIMITER" | "AUTH_RATE_LIMITER", key?: (c: Context<E>) => string | undefined) =>
    rateLimitWrites<E>((c) => c.env[binding], { retryAfterSeconds: rl?.retryAfterSeconds, key, binding });
  if (rl) {
    // Auth writes also pass their own, tighter bucket; with a `key`, the general limit moves after the context.
    app.use(`${auth.basePath ?? DEFAULT_AUTH_BASE_PATH}/*`, limit("AUTH_RATE_LIMITER"));
    app.use(rl.key ? "/mcp" : "*", limit("RATE_LIMITER"));
  }

  app.get("/health", (c) => c.json({ ok: true }));

  // Remote MCP (MCP tokens only, every call audited). Before the session / API-key middleware: /mcp never accepts them.
  if (options.mcp !== false) app.route("/", createMcpRoute<E>({ config, snapshot, engine, audit: options.mcp?.audit, getD1: (c) => c.env.DB }));

  authRoutes(app, auth);
  app.use("*", castraContext<E>(auth));
  if (rl?.key) app.use("*", limit("RATE_LIMITER", rl.key));

  app.get("/me", (c) => {
    const ctx = c.get("ctx");
    return c.json({ user: ctx.user, roles: ctx.roles, via: ctx.via });
  });

  options.routes?.(app);

  // Mounted last so the auth handler and custom routes win on their paths.
  app.route(
    "/",
    createRestRouter<E>({
      config,
      snapshot,
      engine,
      getDb: (c) => kyselyFor(c.env.DB),
      getD1: (c) => c.env.DB,
      getContext: (c) => c.get("ctx"),
      openapi: options.openapi,
    }),
  );

  return app;
}
