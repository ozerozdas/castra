import {
  authRoutes,
  castraContext,
  requireRole,
  type AuthEnv,
  type CastraAuthOptions,
  type CastraAuthVariables,
} from "@castra/auth";
import { Hono } from "hono";

export interface Env extends AuthEnv {
  DB: D1Database;
}

/** Role list for the example (mirrors `roles` in ARCHITECTURE §7). */
export const authOptions: CastraAuthOptions = {
  roles: ["admin", "editor", "member"],
};

const app = new Hono<{ Bindings: Env; Variables: CastraAuthVariables }>();

app.get("/health", (c) => c.json({ ok: true }));

authRoutes(app, authOptions);
app.use("*", castraContext(authOptions));

app.get("/me", (c) => {
  const ctx = c.get("ctx");
  return c.json({ user: ctx.user, roles: ctx.roles, via: ctx.via });
});

// Demo of a role-gated custom route.
app.get("/admin/ping", requireRole("admin"), (c) => c.json({ pong: true }));

export default app;
