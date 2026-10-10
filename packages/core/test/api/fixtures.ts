import {
  authenticated,
  createPolicyEngine,
  defineConfig,
  isPublic,
  owner,
  role,
  type CastraConfig,
  type PolicyEngine,
  type SchemaSnapshot,
} from "../../src/index.js";
import { blogSnapshot } from "../policy/fixtures.js";

export { anon, user } from "../policy/fixtures.js";

function fk(column: string, referencesTable: string, referencesColumn = "id") {
  return { column, referencesTable, referencesColumn, onDelete: "NO ACTION", onUpdate: "NO ACTION" };
}

/** The policy tests' blog snapshot plus the FKs the includes are derived from. */
export const snapshot: SchemaSnapshot = {
  ...blogSnapshot,
  tables: {
    ...blogSnapshot.tables,
    posts: { ...blogSnapshot.tables.posts!, foreignKeys: [fk("author_id", "users")] },
    comments: { ...blogSnapshot.tables.comments!, foreignKeys: [fk("post_id", "posts"), fk("user_id", "users")] },
  },
};

/** ARCHITECTURE §7 config, as in examples/blog/castra.config.ts. */
export const config: CastraConfig = defineConfig({
  database: "d1",
  roles: ["admin", "editor", "member"],
  api: { maxLimit: 100 },
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
        views: { hidden: true },
      },
      filterable: ["status", "created_at", "title"],
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
      fields: { email: { visibleTo: ["self", "admin"] }, password_hash: { hidden: true } },
    },
    items: {
      read: isPublic(),
      create: authenticated(),
      update: owner("owner_id"),
      fields: { owner_id: { setBy: "server" } },
    },
  },
});

export function makeEngine(cfg: CastraConfig = config): PolicyEngine {
  return createPolicyEngine({ config: cfg, snapshot });
}
