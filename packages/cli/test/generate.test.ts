import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueryFn } from "castra";
import { run } from "../src/run.js";
import type { OpenDatabaseFn } from "../src/local-d1.js";
import { openLocalD1 } from "../src/local-d1.js";
import { readD1Target } from "../src/wrangler-config.js";

/** Minimal fake database answering exactly the statements `introspect` issues. */
function fakeDb(extraColumn = false): QueryFn {
  return async (sql) => {
    if (sql.startsWith("SELECT name FROM sqlite_master")) return [{ name: "notes" }, { name: "_cf_METADATA" }];
    if (sql === 'PRAGMA table_info("notes")') {
      return [
        { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
        { cid: 1, name: "body", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        ...(extraColumn ? [{ cid: 2, name: "extra", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 }] : []),
      ];
    }
    return [];
  };
}

function opener(query: QueryFn, closed: { count: number } = { count: 0 }): OpenDatabaseFn {
  return async () => ({ query, close: async () => void closed.count++ });
}

const WRANGLER = `{
  // comments and trailing commas are allowed in wrangler.jsonc
  "name": "app", /* block */
  "d1_databases": [{ "binding": "DB", "database_name": "app-db", "database_id": "x", }],
}`;

let dir: string;
let out: string[];
let err: string[];

const exec = (argv: string[], open: OpenDatabaseFn) =>
  run(argv, { cwd: dir, log: (l) => out.push(l), error: (l) => err.push(l), openDatabase: open });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "castra-cli-"));
  await writeFile(join(dir, "wrangler.jsonc"), WRANGLER);
  out = [];
  err = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("castra generate", () => {
  it("writes schema.json and db.d.ts and closes the database", async () => {
    const closed = { count: 0 };
    expect(await exec(["generate", "--local"], opener(fakeDb(), closed))).toBe(0);
    expect(closed.count).toBe(1);

    const schema = JSON.parse(await readFile(join(dir, "castra", "schema.json"), "utf8"));
    expect(Object.keys(schema.tables)).toEqual(["notes"]);
    expect(schema.tables.notes.primaryKey).toEqual(["id"]);

    const types = await readFile(join(dir, "castra", "db.d.ts"), "utf8");
    expect(types).toContain("export interface NotesTable {");
    expect(types).toContain("body: string | null;");
  });

  it("honours --out and --config", async () => {
    await writeFile(join(dir, "custom.jsonc"), WRANGLER);
    expect(await exec(["generate", "--config", "custom.jsonc", "--out", "gen/dir"], opener(fakeDb()))).toBe(0);
    expect(existsSync(join(dir, "gen", "dir", "schema.json"))).toBe(true);
  });

  it("leaves the committed file untouched when nothing changed (stable generatedAt)", async () => {
    await exec(["generate"], opener(fakeDb()));
    const first = await readFile(join(dir, "castra", "schema.json"), "utf8");
    await new Promise((r) => setTimeout(r, 5));
    await exec(["generate"], opener(fakeDb()));
    expect(await readFile(join(dir, "castra", "schema.json"), "utf8")).toBe(first);
  });

  it("--check exits 0 when the snapshot matches", async () => {
    await exec(["generate"], opener(fakeDb()));
    expect(await exec(["generate", "--check"], opener(fakeDb()))).toBe(0);
    expect(err).toEqual([]);
  });

  it("--check exits 1 with the drift list when the database changed", async () => {
    await exec(["generate"], opener(fakeDb()));
    expect(await exec(["generate", "--check"], opener(fakeDb(true)))).toBe(1);
    expect(err.join("\n")).toContain('table "notes": column "extra" is not in the snapshot');
  });

  it("--check exits 1 when the snapshot is missing or db.d.ts is stale", async () => {
    expect(await exec(["generate", "--check"], opener(fakeDb()))).toBe(1);
    expect(err.join("\n")).toContain("does not exist");

    await exec(["generate"], opener(fakeDb()));
    await writeFile(join(dir, "castra", "db.d.ts"), "// edited\n");
    err.length = 0;
    expect(await exec(["generate", "--check"], opener(fakeDb()))).toBe(1);
    expect(err.join("\n")).toContain("db.d.ts");
  });

  it("--check never writes", async () => {
    await exec(["generate", "--check"], opener(fakeDb()));
    expect(existsSync(join(dir, "castra"))).toBe(false);
  });

  it("fails clearly on a missing config, bad flags and unknown bindings", async () => {
    expect(await exec(["generate", "--config", "nope.jsonc"], opener(fakeDb()))).toBe(2);
    expect(err.join("\n")).toContain("Wrangler config not found");

    err.length = 0;
    expect(await exec(["generate", "--bogus"], opener(fakeDb()))).toBe(2);

    err.length = 0;
    expect(await exec(["generate", "--binding", "OTHER"], opener(fakeDb()))).toBe(2);
    expect(err.join("\n")).toContain('No D1 binding named "OTHER"');
  });

  it("closes the database even when introspection fails", async () => {
    const closed = { count: 0 };
    const boom: QueryFn = async () => {
      throw new Error("boom");
    };
    expect(await exec(["generate"], opener(boom, closed))).toBe(1);
    expect(closed.count).toBe(1);
    expect(err.join("\n")).toContain("boom");
  });
});

describe("castra dispatch", () => {
  it.each(["init", "test", "mcp"])(
    "%s is not implemented yet and exits 2",
    async (cmd) => {
      expect(await exec([cmd], opener(fakeDb()))).toBe(2);
      expect(err.join("\n")).toContain("not implemented yet");
    },
  );

  it("prints usage for no arguments and exits 2 for unknown commands", async () => {
    expect(await exec([], opener(fakeDb()))).toBe(0);
    expect(out.join("\n")).toContain("Usage: castra");
    expect(await exec(["frobnicate"], opener(fakeDb()))).toBe(2);
    expect(err.join("\n")).toContain("Unknown command");
  });
});

describe("readD1Target", () => {
  it("parses JSONC and picks the only binding", () => {
    expect(readD1Target(WRANGLER)).toEqual({ binding: "DB", databaseName: "app-db" });
  });

  it("requires --binding when several databases exist", () => {
    const two = `{ "d1_databases": [{ "binding": "A" }, { "binding": "B", "database_name": "b" }] }`;
    expect(() => readD1Target(two)).toThrow(/--binding/);
    expect(readD1Target(two, "B")).toEqual({ binding: "B", databaseName: "b" });
  });

  it("rejects configs without D1 or with syntax errors", () => {
    expect(() => readD1Target(`{ "name": "x" }`)).toThrow(/No d1_databases/);
    expect(() => readD1Target(`{ "d1_databases": [ }`)).toThrow(/Cannot parse/);
  });
});

// Real local D1 (miniflare state written by `pnpm --filter blog db:migrate:local`). Skipped when absent, e.g. in CI.
const blogDir = fileURLToPath(new URL("../../../examples/blog", import.meta.url));
const hasBlogState = existsSync(join(blogDir, ".wrangler", "state", "v3", "d1"));

describe.skipIf(!hasBlogState)("castra generate against the blog example's local D1", () => {
  it("snapshots users, posts, comments and audit_logs, and matches the committed snapshot", async () => {
    const outDir = join(dir, "gen");
    await mkdir(outDir, { recursive: true });
    const code = await run(["generate", "--local", "--config", join(blogDir, "wrangler.jsonc"), "--out", outDir], {
      cwd: dir,
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      openDatabase: openLocalD1,
    });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    const schema = JSON.parse(await readFile(join(outDir, "schema.json"), "utf8"));
    expect(Object.keys(schema.tables)).toEqual(["audit_logs", "comments", "posts", "users"]);
    expect(schema.tables.comments.foreignKeys.map((f: { column: string }) => f.column)).toEqual(["post_id", "user_id"]);
  }, 30_000);
});
