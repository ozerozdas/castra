import { createCastraApp, type CastraBindings } from "@castra-kit/app";
import { requireRole, type CastraAuthOptions } from "@castra-kit/auth";
import type { SchemaSnapshot } from "@castra-kit/core";
import config from "../castra.config";
import schema from "../castra/schema.json";

export type Env = CastraBindings;

/** Role list for the example (mirrors `roles` in castra.config.ts). */
export const authOptions: CastraAuthOptions = {
  roles: config.roles,
};

export default createCastraApp<Env>({
  config,
  snapshot: schema as unknown as SchemaSnapshot,
  auth: authOptions,
  openapi: { title: "Castra blog example" },
  // Demo of a role-gated custom route.
  routes: (app) => app.get("/admin/ping", requireRole("admin"), (c) => c.json({ pong: true })),
});
