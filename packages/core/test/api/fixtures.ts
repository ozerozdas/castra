import { sql, type CompiledQuery, type Kysely } from "kysely";
import {
  authenticated,
  createPolicyEngine,
  defineConfig,
  isPublic,
  owner,
  role,
  type CastraConfig,
  type CastraContext,
  type PolicyEngine,
  type SchemaSnapshot,
} from "../../src/index.js";
import { compileOnlyDb, partialEvaluate, residualToExpression } from "../../src/policy/compile.js";
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

/**
 * TEST-ONLY stand-in for the policy agent's `engine.writeGuard` (ADR 0043), which is not merged yet:
 * `SELECT CASE WHEN EXISTS (row by pk under the op's rule) THEN 1 ELSE json('castra_write_guard') END`.
 * The json() call raises "malformed JSON", aborting and rolling back the batch.
 */
export function withTestWriteGuard(engine: PolicyEngine, cfg: CastraConfig = config): PolicyEngine {
  const writeGuard = (table: string, op: "create" | "update", ctx: CastraContext, pk: Record<string, unknown>): CompiledQuery => {
    const rule = cfg.tables[table]?.[op];
    if (!rule) throw new Error("no rule");
    const residual = partialEvaluate(rule.node, ctx, table);
    const [[col, value]] = Object.entries(pk) as [[string, unknown]];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = compileOnlyDb() as Kysely<any>;
    const exists = db
      .selectFrom(table)
      .select(sql<number>`1`.as("x"))
      .where((eb) => eb.and([eb(sql.id(table, col), "=", value), residualToExpression(residual, eb)]));
    return db
      .selectNoFrom(sql<number>`CASE WHEN EXISTS ${exists} THEN 1 ELSE json('castra_write_guard') END`.as("ok"))
      .compile();
  };
  return { ...engine, writeGuard } as PolicyEngine;
}

export function makeEngine(cfg: CastraConfig = config): PolicyEngine {
  return createPolicyEngine({ config: cfg, snapshot });
}
