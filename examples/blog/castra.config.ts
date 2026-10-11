import { authenticated, defineConfig, isPublic, owner, role } from "@castra-kit/core";

/**
 * Castra config for the blog example (ARCHITECTURE §7, adjusted to the blog's columns).
 * `audit_logs` has no policy, so it is never exposed. Better Auth and `_castra_*` tables can never be.
 */
export default defineConfig({
  database: "d1",
  auth: { provider: "better-auth", methods: ["email", "github"] },
  storage: false,
  api: { maxLimit: 100 },
  roles: ["admin", "editor", "member"],
  tables: {
    posts: {
      read: isPublic()
        .where((q) => q.eb("status", "=", "published"))
        .or(owner("author_id"))
        .or(role("admin")),
      create: authenticated(),
      update: owner("author_id").or(role("editor", "admin")),
      delete: role("admin"),
      fields: {
        author_id: { setBy: "server" },
        internal_notes: { visibleTo: ["admin"] },
      },
      filterable: ["status", "created_at"],
    },
    comments: {
      read: isPublic(),
      create: authenticated(),
      update: owner("user_id"),
      delete: owner("user_id").or(role("admin")),
      fields: { user_id: { setBy: "server" } },
    },
    users: {
      read: authenticated(),
      fields: { email: { visibleTo: ["self", "admin"] } },
    },
  },
});
