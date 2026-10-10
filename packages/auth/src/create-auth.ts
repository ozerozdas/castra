import { betterAuth, type BetterAuthOptions } from "better-auth";
import { bearer } from "better-auth/plugins";
import { createAuthDb } from "./db.js";

/** Worker bindings and secrets the auth layer reads. */
export interface AuthEnv {
  /** D1 binding holding Better Auth, `_castra_*` and app tables. */
  DB: D1Database;
  /** Worker secret, at least 32 characters. Never committed. */
  BETTER_AUTH_SECRET: string;
  /** Public base URL of the Worker (e.g. `https://api.example.com`). Inferred from requests when absent. */
  BETTER_AUTH_URL?: string;
  /** GitHub OAuth app client id. GitHub sign-in is enabled only when both GitHub values are set. */
  GITHUB_CLIENT_ID?: string;
  /** GitHub OAuth app client secret (Worker secret). */
  GITHUB_CLIENT_SECRET?: string;
}

/** Options for the Castra auth layer. */
export interface CastraAuthOptions {
  /** The configured role list (`defineConfig({ roles })`). Roles outside it are rejected or ignored. */
  roles: readonly string[];
  /** Mount path of the Better Auth handler. Default `/api/auth`. */
  basePath?: string;
  /** Overrides `env.BETTER_AUTH_URL`. */
  baseURL?: string;
  /** Extra origins allowed to call the auth endpoints (CSRF / origin check). */
  trustedOrigins?: string[];
  /** Mirror `id`, `email`, `name` into the app `users` table on user create/update. Default `true`. */
  mirrorUsers?: boolean;
}

/** Default mount path for the Better Auth handler. */
export const DEFAULT_AUTH_BASE_PATH = "/api/auth";
const MIN_SECRET_LENGTH = 32;

/**
 * Builds the Better Auth options Castra uses. Exposed so schema generation and tests use exactly the
 * runtime configuration. Pure: does not touch the database.
 */
export function buildAuthOptions(env: AuthEnv, options: CastraAuthOptions): BetterAuthOptions {
  const secret = env.BETTER_AUTH_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET must be set (Worker secret, at least ${MIN_SECRET_LENGTH} characters).`,
    );
  }
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
      : undefined;
  const mirror = options.mirrorUsers !== false;
  const baseURL = options.baseURL ?? env.BETTER_AUTH_URL;

  return {
    // Native D1 support: Better Auth detects the binding and runs its Kysely D1 dialect (ADR 0020).
    database: env.DB,
    secret,
    ...(baseURL ? { baseURL } : {}),
    basePath: options.basePath ?? DEFAULT_AUTH_BASE_PATH,
    ...(options.trustedOrigins ? { trustedOrigins: options.trustedOrigins } : {}),
    emailAndPassword: { enabled: true },
    ...(github ? { socialProviders: github } : {}),
    // Sessions live only in D1: no secondaryStorage, no cookie cache (ARCHITECTURE §9, ADR 0021).
    session: { cookieCache: { enabled: false } },
    advanced: { database: { generateId: "uuid" } },
    plugins: [bearer()],
    databaseHooks: mirror
      ? {
          user: {
            create: {
              after: async (user) => {
                await createAuthDb(env.DB)
                  .insertInto("users")
                  .values({ id: user.id, email: user.email, name: user.name ?? null })
                  .onConflict((oc) =>
                    oc.column("id").doUpdateSet({ email: user.email, name: user.name ?? null }),
                  )
                  .execute();
              },
            },
            update: {
              after: async (user) => {
                await createAuthDb(env.DB)
                  .updateTable("users")
                  .set({ email: user.email, name: user.name ?? null })
                  .where("id", "=", user.id)
                  .execute();
              },
            },
          },
        }
      : undefined,
  } satisfies BetterAuthOptions;
}

/**
 * Creates a Better Auth instance on the `DB` D1 binding with email+password, optional GitHub,
 * and the bearer plugin (session token in `Authorization: Bearer`).
 */
export function createAuth(env: AuthEnv, options: CastraAuthOptions) {
  return betterAuth(buildAuthOptions(env, options));
}

/** The Better Auth instance type returned by {@link createAuth}. */
export type CastraAuth = ReturnType<typeof createAuth>;
