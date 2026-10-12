import { createCastraApp, type CastraBindings } from "@castra-kit/app";
import type { CastraAuthOptions } from "@castra-kit/auth";
import type { SchemaSnapshot } from "@castra-kit/core";
import config from "../castra.config";
import schema from "../castra/schema.json";

/** The Worker's bindings. Add your own here. */
export type Env = CastraBindings;

/** Roles known to auth (mirrors `roles` in castra.config.ts). Add `trustedOrigins` etc. here. */
export const authOptions: CastraAuthOptions = {
  roles: config.roles,
};

// Auth, REST, MCP, rate limiting and problem+json come from @castra-kit/app (ADR 0077), so upgrades are a
// package bump. Use `before` for CORS or logging and `routes` for custom routes (they see `c.get("ctx")`).
export default createCastraApp<Env>({
  config,
  snapshot: schema as unknown as SchemaSnapshot,
  auth: authOptions,
  openapi: { title: "Castra app" },
});
