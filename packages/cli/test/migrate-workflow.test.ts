import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnExec, type ExecFn } from "../src/exec.js";
import { openLocalD1 } from "../src/local-d1.js";
import { run } from "../src/run.js";
import { FAKE_TOKEN, FakeCloudflare, forbidRealNetwork } from "./fake-cloudflare.js";
import { BLOG_CONFIG, PROVISIONED_CONFIG } from "./fixtures.js";

forbidRealNetwork();

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
}

describe("castra migrate create (ADR 0080)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "castra-migrate-"));
    await writeFile(join(dir, "wrangler.jsonc"), BLOG_CONFIG);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("creates the directory, numbers after the highest file and slugs the name", async () => {
    const io = capture();
    expect(await run(["migrate", "create", "Add", "Tags!"], { cwd: dir, ...io })).toBe(0);
    expect(await readdir(join(dir, "migrations"))).toEqual(["0001_add_tags.sql"]);
    expect(io.out).toEqual([`Created ${join("migrations", "0001_add_tags.sql")}`]);
    await writeFile(join(dir, "migrations", "0003_castra_internal.sql"), "");
    expect(await run(["migrate", "create", "posts-slug"], { cwd: dir, ...io })).toBe(0);
    expect(await readdir(join(dir, "migrations"))).toContain("0004_posts_slug.sql");
    expect(await readFile(join(dir, "migrations", "0004_posts_slug.sql"), "utf8")).toMatch(/^-- posts-slug\n[\s\S]*Rollback:/);
  });

  it("needs a usable name and refuses migrations_pattern layouts", async () => {
    const io = capture();
    expect(await run(["migrate", "create"], { cwd: dir, ...io })).toBe(2);
    expect(await run(["migrate", "create", "!!!"], { cwd: dir, ...io })).toBe(2);
    await writeFile(join(dir, "wrangler.jsonc"), BLOG_CONFIG.replace(`"migrations_dir": "migrations"`, `"migrations_dir": "migrations", "migrations_pattern": "**/*.sql"`));
    expect(await run(["migrate", "create", "x"], { cwd: dir, ...io })).toBe(1);
    expect(io.err.join("\n")).toMatch(/migrations_pattern/);
  });
});

// End to end on a real local D1: the files castra writes are the ones `wrangler d1 migrations apply` runs, and
// status reads wrangler's own d1_migrations table. Lives under packages/cli so the CLI's wrangler is used.
const cliDir = fileURLToPath(new URL("..", import.meta.url));
const exec: ExecFn = (command, args, options) =>
  spawnExec(command, args, {
    ...options,
    echo: false,
    env: { ...options.env, PATH: [join(cliDir, "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter), WRANGLER_SEND_METRICS: "false" },
  });

describe("castra migrate status / apply (local D1)", () => {
  let project: string;
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    // Local runs never need Cloudflare credentials; keep the spawned wrangler away from any real ones.
    for (const k of Object.keys(process.env).filter((k) => k.startsWith("CLOUDFLARE_"))) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    project = join(cliDir, `.migrate-test-${process.pid}`);
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "wrangler.jsonc"), BLOG_CONFIG.replace('"main": "src/index.ts",\n', ""));
  });
  afterAll(async () => {
    Object.assign(process.env, saved);
    await rm(project, { recursive: true, force: true });
  });

  it("create -> pending -> migrate -> applied; a recorded name without a file is unknown", async () => {
    const io = capture();
    expect(await run(["migrate", "create", "notes"], { cwd: project, ...io })).toBe(0);
    await writeFile(join(project, "migrations", "0001_notes.sql"), "CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL);\n", { flag: "a" });
    expect(await run(["migrate", "create", "notes title"], { cwd: project, ...io })).toBe(0);
    await writeFile(join(project, "migrations", "0002_notes_title.sql"), "ALTER TABLE notes ADD COLUMN title TEXT;\n", { flag: "a" });

    io.out.length = 0;
    expect(await run(["migrate", "status"], { cwd: project, ...io })).toBe(0);
    expect(io.out.join("\n")).toMatch(/pending {2}0001_notes\.sql\n {2}pending {2}0002_notes_title\.sql\n0 applied, 2 pending - run `castra migrate`\./);

    expect(await run(["migrate"], { cwd: project, exec, ...io })).toBe(0);
    io.out.length = 0;
    expect(await run(["migrate", "status", "--local"], { cwd: project, ...io })).toBe(0);
    expect(io.out.slice(-1)).toEqual(["2 applied, 0 pending."]);

    await rm(join(project, "migrations", "0002_notes_title.sql"));
    io.out.length = 0;
    expect(await run(["migrate", "status"], { cwd: project, ...io })).toBe(0);
    expect(io.out.join("\n")).toMatch(/unknown {2}0002_notes_title\.sql/);
  }, 120_000);

  it("--remote reads the same table through the D1 HTTP API", async () => {
    // Same migrations dir, provisioned id. Local D1 state is keyed by database_id, so the local side keeps wrangler.jsonc.
    await writeFile(join(project, "remote.jsonc"), PROVISIONED_CONFIG.replace('"main": "src/index.ts",\n', ""));
    const cf = new FakeCloudflare();
    // The "remote" database is this project's local D1, so the answer is wrangler's real bookkeeping.
    cf.d1Query = async (sql, params) => {
      const db = await openLocalD1(join(project, "wrangler.jsonc"), "DB");
      try {
        return await db.query(sql, params);
      } finally {
        await db.close();
      }
    };
    const io = capture();
    const openDatabase = async () => {
      throw new Error("local database must not be opened with --remote");
    };
    expect(await run(["migrate", "status", "--remote", "--config", "remote.jsonc"], { cwd: project, env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN }, fetch: cf.fetch, openDatabase, ...io })).toBe(0);
    expect(io.out.join("\n")).toMatch(/applied {2}0001_notes\.sql/);
    expect(cf.calls.filter((c) => c.path.endsWith("/query"))).toHaveLength(2);
  }, 60_000);
});
