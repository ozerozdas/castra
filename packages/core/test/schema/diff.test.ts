import { describe, expect, it } from "vitest";
import { diffSnapshots } from "../../src/schema/index.js";
import type { SchemaSnapshot } from "../../src/types.js";

const base = (): SchemaSnapshot => ({
  version: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  tables: {
    posts: {
      name: "posts",
      columns: [
        { name: "id", type: "TEXT", affinity: "TEXT", notNull: true, defaultValue: null, primaryKeyPosition: 1 },
        { name: "title", type: "TEXT", affinity: "TEXT", notNull: true, defaultValue: null, primaryKeyPosition: 0 },
      ],
      primaryKey: ["id"],
      foreignKeys: [
        { column: "id", referencesTable: "users", referencesColumn: "id", onDelete: "NO ACTION", onUpdate: "NO ACTION" },
      ],
      indexes: [{ name: "idx_title", unique: false, columns: ["title"] }],
    },
  },
});

describe("diffSnapshots", () => {
  it("reports no drift for identical snapshots, ignoring generatedAt", () => {
    const b = base();
    b.generatedAt = "2030-12-31T00:00:00.000Z";
    expect(diffSnapshots(base(), b)).toEqual([]);
  });

  it("reports a STRICT change and treats an absent flag as non-STRICT", () => {
    const b = base();
    b.tables.posts!.strict = true;
    expect(diffSnapshots(base(), b)).toEqual(['table "posts": STRICT changed from false to true']);
    expect(diffSnapshots(b, structuredClone(b))).toEqual([]);
  });

  it("reports missing and extra tables", () => {
    const b = base();
    b.tables.extra = { name: "extra", columns: [], primaryKey: [], foreignKeys: [], indexes: [] };
    expect(diffSnapshots(base(), b)).toEqual(['table "extra" is not in the snapshot']);
    expect(diffSnapshots(b, base())).toEqual(['table "extra" is missing from the database']);
  });

  it("reports added, removed and changed columns", () => {
    const b = base();
    const posts = b.tables.posts!;
    posts.columns.push({ name: "body", type: "TEXT", affinity: "TEXT", notNull: false, defaultValue: null, primaryKeyPosition: 0 });
    posts.columns[1] = { ...posts.columns[1]!, type: "VARCHAR(10)", notNull: false, defaultValue: "'x'" };
    expect(diffSnapshots(base(), b)).toEqual([
      'table "posts": column "body" is not in the snapshot',
      'table "posts", column "title": type changed from "TEXT" to "VARCHAR(10)"',
      'table "posts", column "title": notNull changed from true to false',
      `table "posts", column "title": defaultValue changed from null to "'x'"`,
    ]);
    expect(diffSnapshots(b, base())[0]).toBe('table "posts": column "body" is missing from the database');
  });

  it("reports a collation change and treats an absent collation as BINARY", () => {
    const b = base();
    b.tables.posts!.columns[1]!.collation = "NOCASE";
    expect(diffSnapshots(base(), b)).toEqual(['table "posts", column "title": collation changed from "BINARY" to "NOCASE"']);
  });

  it("reports primary key changes", () => {
    const b = base();
    b.tables.posts!.primaryKey = ["id", "title"];
    expect(diffSnapshots(base(), b)).toEqual(['table "posts": primary key changed from (id) to (id, title)']);
  });

  it("reports foreign key additions and action changes", () => {
    const b = base();
    b.tables.posts!.foreignKeys[0]!.onDelete = "CASCADE";
    expect(diffSnapshots(base(), b)).toEqual([
      'table "posts": foreign key "id -> users.id" changed from id -> users.id (on delete NO ACTION, on update NO ACTION) to id -> users.id (on delete CASCADE, on update NO ACTION)',
    ]);
    b.tables.posts!.foreignKeys = [];
    expect(diffSnapshots(base(), b)).toEqual(['table "posts": foreign key "id -> users.id" is missing from the database']);
  });

  it("reports index changes", () => {
    const b = base();
    b.tables.posts!.indexes = [
      { name: "idx_title", unique: true, columns: ["title", "id"] },
      { name: "idx_new", unique: false, columns: ["id"] },
    ];
    expect(diffSnapshots(base(), b)).toEqual([
      'table "posts": index "idx_new" is not in the snapshot',
      'table "posts": index "idx_title" changed from (title) to unique (title, id)',
    ]);
  });

  it("reports column order changes", () => {
    const b = base();
    b.tables.posts!.columns.reverse();
    expect(diffSnapshots(base(), b)).toEqual(['table "posts": column order changed from [id, title] to [title, id]']);
  });

  it("is deterministic regardless of table insertion order", () => {
    const a = base();
    const b = base();
    for (const n of ["z", "a", "m"]) {
      b.tables[n] = { name: n, columns: [], primaryKey: [], foreignKeys: [], indexes: [] };
    }
    expect(diffSnapshots(a, b)).toEqual([
      'table "a" is not in the snapshot',
      'table "m" is not in the snapshot',
      'table "z" is not in the snapshot',
    ]);
  });
});
