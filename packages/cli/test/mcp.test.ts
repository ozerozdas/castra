import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { introspect } from "@castra-kit/core";
import { AUDIT_PRUNE_BATCH } from "@castra-kit/mcp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openLocalD1, type OpenDatabaseFn } from "../src/local-d1.js";
import { run } from "../src/run.js";
import { FAKE_TOKEN, FakeCloudflare, forbidRealNetwork } from "./fake-cloudflare.js";
import { BLOG_CONFIG, PROVISIONED_CONFIG } from "./fixtures.js";

forbidRealNetwork();

const TOKEN_RE = /^castra_mcp_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;

/** A fake database answering the three statements token commands issue. */
function fakeDb(users: string[]) {
  const tokens = new Map<string, Record<string, unknown>>();
  const statements: { sql: string; params: unknown[] }[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    if (/^select id from "user"/i.test(sql)) return users.includes(String(params[0])) ? [{ id: params[0] }] : [];
    if (/^insert into "_castra_mcp_tokens"/i.test(sql)) {
      tokens.set(String(params[0]), { id: params[0], params });
      return [];
    }
    if (/^update "_castra_mcp_tokens"/i.test(sql)) {
      const id = String(params[1]);
      const t = tokens.get(id);
      if (!t || t.revoked) return [];
      t.revoked = true;
      return [{ id }];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { tokens, statements, query };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "castra-mcp-token-"));
  await writeFile(join(dir, "wrangler.jsonc"), BLOG_CONFIG);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
}

describe("castra mcp token (local)", () => {
  it("creates a token for an existing user, prints it once, stores only the hash", async () => {
    const db = fakeDb(["u1"]);
    const opened: string[] = [];
    const openDatabase: OpenDatabaseFn = async (path, binding) => {
      opened.push(`${path}#${binding}`);
      return { query: db.query, close: async () => {} };
    };
    const io = capture();
    const code = await run(["mcp", "token", "create", "--user", "u1", "--scopes", "data:read,schema:read", "--name", "ci", "--expires-in", "30"], { cwd: dir, openDatabase, ...io });
    expect(code).toBe(0);
    expect(opened).toEqual([`${join(dir, "wrangler.jsonc")}#DB`]);
    expect(io.out).toHaveLength(1);
    expect(io.out[0]).toMatch(TOKEN_RE);
    const insert = db.statements.find((s) => /^insert/i.test(s.sql))!;
    expect(JSON.stringify(insert.params)).not.toContain(io.out[0]!.split("_").pop());
    expect(insert.params).toContain("schema:read data:read");
    expect(io.err.join("\n")).toMatch(/not shown again/);
  });
  it("rejects unknown users, unknown scopes and missing flags", async () => {
    const db = fakeDb([]);
    const openDatabase: OpenDatabaseFn = async () => ({ query: db.query, close: async () => {} });
    const io = capture();
    expect(await run(["mcp", "token", "create", "--user", "ghost", "--scopes", "data:read"], { cwd: dir, openDatabase, ...io })).toBe(1);
    expect(io.err.join()).toMatch(/no user with id "ghost"/);
    expect(await run(["mcp", "token", "create", "--user", "u1", "--scopes", "admin"], { cwd: dir, openDatabase, ...io })).toBe(2);
    expect(await run(["mcp", "token", "create", "--user", "u1"], { cwd: dir, openDatabase, ...io })).toBe(2);
    expect(await run(["mcp", "token", "create", "--user", "u1", "--scopes", "data:read", "--expires-in", "-1"], { cwd: dir, openDatabase, ...io })).toBe(2);
    expect(await run(["mcp", "token", "nope"], { cwd: dir, openDatabase, ...io })).toBe(2);
    expect(db.tokens.size).toBe(0);
  });
  it("revokes once; a second revoke exits 1", async () => {
    const db = fakeDb(["u1"]);
    const openDatabase: OpenDatabaseFn = async () => ({ query: db.query, close: async () => {} });
    const io = capture();
    await run(["mcp", "token", "create", "--user", "u1", "--scopes", "schema:read"], { cwd: dir, openDatabase, ...io });
    const id = io.out[0]!.split("_")[2]!;
    expect(await run(["mcp", "token", "revoke", id], { cwd: dir, openDatabase, ...io })).toBe(0);
    expect(await run(["mcp", "token", "revoke", id], { cwd: dir, openDatabase, ...io })).toBe(1);
    expect(await run(["mcp", "token", "revoke"], { cwd: dir, openDatabase, ...io })).toBe(2);
  });
});

describe("castra mcp audit prune", () => {
  it("deletes in batches until a short batch, and prints the total", async () => {
    const batches = [AUDIT_PRUNE_BATCH, 3];
    const seen: unknown[][] = [];
    const openDatabase: OpenDatabaseFn = async () => ({
      query: async (_sql: string, params: unknown[] = []) => {
        seen.push(params);
        return Array.from({ length: batches.shift() ?? 0 }, (_, i) => ({ id: String(i) }));
      },
      close: async () => {},
    });
    const io = capture();
    expect(await run(["mcp", "audit", "prune", "--older-than", "30"], { cwd: dir, openDatabase, ...io })).toBe(0);
    expect(seen).toHaveLength(2);
    expect(String(seen[0]![0])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(io.out.join()).toMatch(new RegExp(`Deleted ${AUDIT_PRUNE_BATCH + 3} audit rows`));
  });
  it("requires a whole, positive --older-than", async () => {
    const openDatabase: OpenDatabaseFn = async () => ({ query: async () => [], close: async () => {} });
    const io = capture();
    for (const bad of [[], ["--older-than", "0"], ["--older-than", "1.5"], ["--older-than", "x"]]) {
      expect(await run(["mcp", "audit", "prune", ...bad], { cwd: dir, openDatabase, ...io })).toBe(2);
    }
    expect(await run(["mcp", "audit", "nope"], { cwd: dir, openDatabase, ...io })).toBe(2);
  });
});

describe("castra mcp token --remote", () => {
  it("writes through the D1 HTTP query API of the provisioned database", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), PROVISIONED_CONFIG);
    const cf = new FakeCloudflare();
    cf.d1Query = (sql, params) => {
      if (/^select id from "user"/i.test(sql)) return params[0] === "u1" ? [{ id: "u1" }] : [];
      if (/^update/i.test(sql)) return [{ id: params[1] }];
      return [];
    };
    const io = capture();
    const env = { CLOUDFLARE_API_TOKEN: FAKE_TOKEN };
    const openDatabase: OpenDatabaseFn = async () => {
      throw new Error("local database must not be opened with --remote");
    };
    expect(await run(["mcp", "token", "create", "--remote", "--user", "u1", "--scopes", "data:read"], { cwd: dir, env, fetch: cf.fetch, openDatabase, ...io })).toBe(0);
    expect(io.out[0]).toMatch(TOKEN_RE);
    const queries = cf.calls.filter((c) => c.path.endsWith("/query"));
    expect(queries.map((q) => q.path)).toEqual([
      "/accounts/acc1/d1/database/6f1c0a3e-1111-4000-8000-000000000001/query",
      "/accounts/acc1/d1/database/6f1c0a3e-1111-4000-8000-000000000001/query",
    ]);
    expect((queries[1]!.body as { sql: string }).sql).toMatch(/^insert into "_castra_mcp_tokens"/);
    expect(await run(["mcp", "token", "revoke", "--remote", "0123456789abcdef"], { cwd: dir, env, fetch: cf.fetch, openDatabase, ...io })).toBe(0);
  });
  it("needs a Cloudflare token", async () => {
    const io = capture();
    expect(await run(["mcp", "token", "revoke", "--remote", "x"], { cwd: dir, env: {}, fetch: new FakeCloudflare().fetch, ...io })).toBe(1);
  });
});

// End to end: the built binary serves stdio against a real local D1 (miniflare via getPlatformProxy) and a
// TypeScript config loaded with Node's type stripping. The project lives under packages/cli (not node_modules,
// where Node refuses to strip types) so `castra` resolves to the same module the CLI uses.
const cliDir = fileURLToPath(new URL("..", import.meta.url));
describe("castra mcp (stdio)", () => {
  let project: string;
  beforeAll(async () => {
    project = join(cliDir, `.mcp-test-${process.pid}`);
    await mkdir(join(project, "castra"), { recursive: true });
    await writeFile(join(project, "wrangler.jsonc"), BLOG_CONFIG.replace('"main": "src/index.ts",\n', ""));
    await writeFile(
      join(project, "castra.config.ts"),
      `import { defineConfig, isPublic, owner } from "@castra-kit/core";
const secretColumn: string = "secret";
export default defineConfig({
  database: "d1",
  roles: ["admin"],
  tables: { notes: { read: isPublic().where((q) => q.eb("status", "=", "published")).or(owner("owner_id")), fields: { [secretColumn]: { hidden: true } } } },
});
`,
    );
    const db = await openLocalD1(join(project, "wrangler.jsonc"), "DB");
    try {
      for (const sql of [
        `CREATE TABLE "user" (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL)`,
        `CREATE TABLE _castra_roles (user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (user_id, role))`,
        `CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL, secret TEXT)`,
        `INSERT INTO "user" VALUES ('u1', 'U', 'u@example.com')`,
        `INSERT INTO notes VALUES ('n1', 'u1', 'published', 'x'), ('n2', 'u1', 'draft', 'x')`,
      ]) {
        await db.query(sql);
      }
      await writeFile(join(project, "castra", "schema.json"), JSON.stringify(await introspect(db.query)));
    } finally {
      await db.close();
    }
  }, 60_000);
  afterAll(() => rm(project, { recursive: true, force: true }));

  it("serves the tools; `as` impersonates any user", async () => {
    const child = spawn(process.execPath, [join(cliDir, "dist", "cli.js"), "mcp"], { cwd: project, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const lines = createInterface({ input: child.stdout });
    const pending = new Map<number, (v: unknown) => void>();
    const nonJson: string[] = [];
    lines.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id !== undefined) pending.get(msg.id)?.(msg);
      } catch {
        nonJson.push(line);
      }
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    let id = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpc = (method: string, params?: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        void exited.then((code) => reject(new Error(`castra mcp exited (${code}): ${stderr}`)));
        pending.set(++id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    try {
      const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
      expect(init.result.serverInfo.name, stderr).toBe("castra-local");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const list = await rpc("tools/list");
      expect(list.result.tools).toHaveLength(4);
      const anon = await rpc("tools/call", { name: "query_data", arguments: { path: "/api/notes" } });
      expect(anon.result.structuredContent.body.data).toEqual([{ id: "n1", owner_id: "u1", status: "published" }]);
      const owner = await rpc("tools/call", { name: "query_data", arguments: { path: "/api/notes", as: { userId: "u1" } } });
      expect(owner.result.structuredContent.body.data.map((n: { id: string }) => n.id).sort()).toEqual(["n1", "n2"]);
      const schema = await rpc("tools/call", { name: "describe_schema", arguments: {} });
      expect(Object.keys(schema.result.structuredContent.tables)).toEqual(["notes"]);
      expect(nonJson).toEqual([]);
    } finally {
      child.stdin.end();
    }
    expect(await exited, stderr).toBe(0);
  }, 60_000);

  it("reports a missing snapshot as a runtime error (exit 1, R5-7)", async () => {
    const io = capture();
    expect(await run(["mcp", "--out", "nowhere"], { cwd: project, ...io })).toBe(1);
    expect(io.err.join()).toMatch(/castra generate/);
  });
});
