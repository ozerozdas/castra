import { authenticated, defineConfig, isPublic, owner, role } from "castra";

/**
 * Castra config. Every table is closed unless it has a policy here; `users` and the auth/internal tables
 * are never exposed. Every rule ships with allow AND deny tests in test/policies.test.ts.
 */
export default defineConfig({
  database: "d1",
  auth: { provider: "better-auth", methods: ["email"] },
  storage: false,
  api: { maxLimit: 100 },
  roles: ["admin", "member"],
  tables: {
    notes: {
      // Anyone (also anonymous) reads public notes; owners read their own; admins read everything.
      read: isPublic()
        .where((q) => q.eb("is_public", "=", 1))
        .or(owner("owner_id"))
        .or(role("admin")),
      // Any signed-in user can create; owner_id is always set by the server to the caller.
      create: authenticated(),
      update: owner("owner_id").or(role("admin")),
      delete: owner("owner_id").or(role("admin")),
      filterable: ["is_public", "created_at"],
    },
  },
});
