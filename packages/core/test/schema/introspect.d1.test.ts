import { beforeAll, describe, expect, it } from "vitest";
import { affinityOf, introspect, isInternalTable, quoteIdentifier } from "../../src/schema/index.js";
import type { QueryFn } from "../../src/schema/index.js";
import type { SchemaSnapshot } from "../../src/types.js";
import { applyFixture, d1Query } from "./fixture.js";

let snapshot: SchemaSnapshot;

beforeAll(async () => {
  await applyFixture();
  snapshot = await introspect(d1Query, { generatedAt: "2026-01-01T00:00:00.000Z" });
});

const col = (table: string, name: string) => {
  const found = snapshot.tables[table]?.columns.find((c) => c.name === name);
  if (!found) throw new Error(`no column ${table}.${name}`);
  return found;
};

describe("introspect (real D1)", () => {
  it("returns version, timestamp and sorted tables", () => {
    expect(snapshot.version).toBe(1);
    expect(snapshot.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(Object.keys(snapshot.tables)).toEqual(["_castra_audit", "post_tags", "posts", "users", 'weird "name"']);
  });

  it("excludes d1_migrations, sqlite_*, and views; keeps _castra_* tables", () => {
    expect(snapshot.tables).not.toHaveProperty("d1_migrations");
    expect(snapshot.tables).not.toHaveProperty("post_titles");
    expect(Object.keys(snapshot.tables).some((n) => n.startsWith("sqlite_"))).toBe(false);
    expect(snapshot.tables).toHaveProperty("_castra_audit");
  });

  it("stamps generatedAt with the current time by default", async () => {
    const s = await introspect(d1Query);
    expect(Number.isNaN(Date.parse(s.generatedAt))).toBe(false);
  });

  it("derives affinity from every kind of declared type, including an undeclared one", () => {
    expect(col("posts", "id")).toMatchObject({ type: "INTEGER", affinity: "INTEGER" });
    expect(col("posts", "views")).toMatchObject({ type: "BIGINT", affinity: "INTEGER" });
    expect(col("posts", "title")).toMatchObject({ type: "VARCHAR(255)", affinity: "TEXT" });
    expect(col("posts", "score")).toMatchObject({ type: "DOUBLE PRECISION", affinity: "REAL" });
    expect(col("post_tags", "weight")).toMatchObject({ type: "REAL", affinity: "REAL" });
    expect(col("posts", "price")).toMatchObject({ type: "DECIMAL(10,2)", affinity: "NUMERIC" });
    expect(col("posts", "cover")).toMatchObject({ type: "BLOB", affinity: "BLOB" });
    expect(col("posts", "payload")).toMatchObject({ type: "", affinity: "BLOB" });
  });

  it("keeps columns in declaration order", () => {
    expect(snapshot.tables.posts?.columns.map((c) => c.name)).toEqual([
      "id",
      "author_id",
      "parent_id",
      "title",
      "score",
      "views",
      "price",
      "cover",
      "payload",
      "status",
    ]);
  });

  it("reports NOT NULL and defaults as SQLite does", () => {
    expect(col("posts", "title").notNull).toBe(true);
    expect(col("posts", "parent_id").notNull).toBe(false);
    expect(col("posts", "status")).toMatchObject({ notNull: true, defaultValue: "'draft'" });
    expect(col("posts", "score")).toMatchObject({ notNull: false, defaultValue: "0.5" });
    expect(col("posts", "cover").defaultValue).toBeNull();
    expect(col("users", "created_at").defaultValue).toBe("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  });

  it("treats a single INTEGER PRIMARY KEY (rowid alias) as not null", () => {
    // PRAGMA table_info reports notnull = 0 for it; reads can never return NULL.
    expect(col("posts", "id")).toMatchObject({ notNull: true, primaryKeyPosition: 1 });
  });

  it("handles composite primary keys ordered by position", () => {
    const t = snapshot.tables.post_tags;
    expect(t?.primaryKey).toEqual(["tag", "post_id"]);
    expect(col("post_tags", "tag").primaryKeyPosition).toBe(1);
    expect(col("post_tags", "post_id").primaryKeyPosition).toBe(2);
    expect(snapshot.tables.users?.primaryKey).toEqual(["id"]);
    expect(snapshot.tables['weird "name"']?.primaryKey).toEqual([]);
  });

  it("captures foreign keys with ON DELETE / ON UPDATE actions", () => {
    expect(snapshot.tables.posts?.foreignKeys).toEqual([
      { column: "author_id", referencesTable: "users", referencesColumn: "id", onDelete: "CASCADE", onUpdate: "NO ACTION" },
      { column: "parent_id", referencesTable: "posts", referencesColumn: "id", onDelete: "NO ACTION", onUpdate: "NO ACTION" },
    ]);
    expect(snapshot.tables.post_tags?.foreignKeys).toEqual([
      { column: "post_id", referencesTable: "posts", referencesColumn: "id", onDelete: "CASCADE", onUpdate: "SET NULL" },
    ]);
  });

  it("resolves an implicit parent column (REFERENCES posts) to the parent's primary key", () => {
    expect(snapshot.tables.posts?.foreignKeys.find((f) => f.column === "parent_id")?.referencesColumn).toBe("id");
  });

  it("lists unique and non-unique indexes sorted by name, without pk, partial or expression indexes", () => {
    expect(snapshot.tables.posts?.indexes).toEqual([
      { name: "idx_posts_author", unique: false, columns: ["author_id"] },
      { name: "uq_posts_title_status", unique: true, columns: ["title", "status"] },
    ]);
  });

  it("includes UNIQUE-constraint indexes", () => {
    expect(snapshot.tables.users?.indexes).toEqual([
      { name: "sqlite_autoindex_users_2", unique: true, columns: ["email"] },
    ]);
  });

  it("handles identifiers containing quotes and spaces", () => {
    expect(snapshot.tables['weird "name"']?.columns.map((c) => c.name)).toEqual(["odd col"]);
  });

  it("is deterministic across runs", async () => {
    const again = await introspect(d1Query, { generatedAt: snapshot.generatedAt });
    expect(again).toEqual(snapshot);
    expect(JSON.stringify(again)).toBe(JSON.stringify(snapshot));
  });
});

describe("introspect (stubbed query)", () => {
  /** A stub database that only answers the statements introspect issues. */
  function stub(tables: string[], pragma: (sql: string, params: unknown[]) => Record<string, unknown>[] = () => []): QueryFn {
    return async (sql, params = []) => {
      if (sql.startsWith("SELECT name FROM sqlite_master")) return tables.map((name) => ({ name }));
      return pragma(sql, params);
    };
  }

  it("excludes sqlite_*, _cf_* and d1_migrations internals but keeps _castra_* and auth tables", async () => {
    // D1 itself refuses to create _cf_* tables, so this case cannot be set up in the real database.
    const s = await introspect(
      stub(["_cf_KV", "sqlite_sequence", "d1_migrations", "_castra_roles", "user", "session", "app"]),
    );
    expect(Object.keys(s.tables)).toEqual(["_castra_roles", "app", "session", "user"]);
  });

  it("resolves implicit composite foreign key columns by position", async () => {
    const s = await introspect(
      stub(["parent", "child"], (sql, params) => {
        if (sql === "SELECT * FROM pragma_table_info(?)" && params[0] === "parent") {
          return [
            { cid: 0, name: "a", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
            { cid: 1, name: "b", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
          ];
        }
        if (sql === "SELECT * FROM pragma_table_info(?)" && params[0] === "child") {
          return [
            { cid: 0, name: "pa", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
            { cid: 1, name: "pb", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
          ];
        }
        if (sql === "SELECT * FROM pragma_foreign_key_list(?)" && params[0] === "child") {
          return [
            { id: 0, seq: 0, table: "parent", from: "pa", to: null, on_update: "NO ACTION", on_delete: "NO ACTION" },
            { id: 0, seq: 1, table: "parent", from: "pb", to: null, on_update: "NO ACTION", on_delete: "NO ACTION" },
          ];
        }
        return [];
      }),
    );
    expect(s.tables.child?.foreignKeys.map((f) => `${f.column}->${f.referencesColumn}`)).toEqual(["pa->a", "pb->b"]);
  });

  it("binds table names as parameters instead of building PRAGMA text", async () => {
    const evil = 'x") ; DROP TABLE users; --';
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    await introspect(
      stub([evil], (sql, params) => {
        seen.push({ sql, params });
        return [];
      }),
    );
    expect(seen).toContainEqual({ sql: "SELECT * FROM pragma_table_info(?)", params: [evil] });
    expect(seen.every((c) => !c.sql.includes("DROP") && !/\bPRAGMA\b/i.test(c.sql))).toBe(true);
  });
});

describe("helpers", () => {
  it("affinityOf follows SQLite's rules in order", () => {
    expect(affinityOf("INT")).toBe("INTEGER");
    expect(affinityOf("unsigned big int")).toBe("INTEGER");
    expect(affinityOf("CHARACTER(20)")).toBe("TEXT");
    expect(affinityOf("CLOB")).toBe("TEXT");
    expect(affinityOf("TEXT")).toBe("TEXT");
    expect(affinityOf("BLOB")).toBe("BLOB");
    expect(affinityOf("")).toBe("BLOB");
    expect(affinityOf("REAL")).toBe("REAL");
    expect(affinityOf("FLOAT")).toBe("REAL");
    expect(affinityOf("DOUBLE")).toBe("REAL");
    expect(affinityOf("NUMERIC")).toBe("NUMERIC");
    expect(affinityOf("BOOLEAN")).toBe("NUMERIC");
    expect(affinityOf("DATETIME")).toBe("NUMERIC");
    // "POINT" contains "INT", rule 1 wins; "CHARINT" hits INT before CHAR.
    expect(affinityOf("POINT")).toBe("INTEGER");
    expect(affinityOf("CHARINT")).toBe("INTEGER");
  });

  it("quoteIdentifier escapes double quotes and rejects NUL", () => {
    expect(quoteIdentifier("posts")).toBe('"posts"');
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
    expect(() => quoteIdentifier("a\0b")).toThrow();
  });

  it("isInternalTable flags only SQLite/D1 internals", () => {
    expect(isInternalTable("sqlite_sequence")).toBe(true);
    expect(isInternalTable("_cf_KV")).toBe(true);
    expect(isInternalTable("d1_migrations")).toBe(true);
    expect(isInternalTable("_castra_audit")).toBe(false);
    expect(isInternalTable("posts")).toBe(false);
    expect(isInternalTable("cf_posts")).toBe(false);
  });
});
