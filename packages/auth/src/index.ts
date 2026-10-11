/**
 * `@castra-kit/auth`: Better Auth on D1, roles, API keys and request context resolution.
 * @packageDocumentation
 */

/** Package identifier. */
export const name = "@castra-kit/auth";

export {
  buildAuthOptions,
  createAuth,
  DEFAULT_AUTH_BASE_PATH,
  type AuthEnv,
  type CastraAuth,
  type CastraAuthOptions,
} from "./create-auth.js";
export { assertKnownRoles, assignRole, getRoles, revokeRole, UnknownRoleError } from "./roles.js";
export {
  API_KEY_PREFIX,
  createApiKey,
  parseApiKey,
  revokeApiKey,
  sha256Hex,
  timingSafeEqual,
  verifyApiKey,
  type CreateApiKeyInput,
  type CreatedApiKey,
  type VerifiedApiKey,
} from "./api-keys.js";
export {
  anonymousContext,
  API_KEY_HEADER,
  resolveContext,
  type ResolveContextDeps,
} from "./context.js";
export {
  authProblem,
  authRoutes,
  castraContext,
  getAuth,
  problem,
  requireRole,
  type CastraAuthHonoEnv,
  type CastraAuthVariables,
  type ProblemDetails,
} from "./hono.js";
export { createAuthDb, type AuthDb, type AuthDbInput, type CastraAuthDatabase } from "./db.js";
