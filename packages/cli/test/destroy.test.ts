import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLACEHOLDER_ID } from "../src/commands/destroy.js";
import { run } from "../src/run.js";
import type { ExecCall } from "./fake-cloudflare.js";
import { FAKE_TOKEN, FakeCloudflare, fakeExec, forbidRealNetwork } from "./fake-cloudflare.js";

forbidRealNetwork();

const CONFIG = `{
  // the blog
  "name": "blog",
  "main": "src/index.ts",
  "d1_databases": [{ "binding": "DB", "database_name": "blog-db", "database_id": "d1-blog" }],
  "kv_namespaces": [
    { "binding": "CACHE", "id": "kv-blog" },
    { "binding": "SHARED", "id": "kv-shared" }
  ],
  "r2_buckets": [{ "binding": "STORAGE", "bucket_name": "blog-storage" }]
}
`;

let dir: string;
let cf: FakeCloudflare;
let out: string[];
let err: string[];
let timeline: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "castra-destroy-"));
  await writeFile(join(dir, "wrangler.jsonc"), CONFIG);
  cf = new FakeCloudflare();
  // Recorded resources, plus look-alikes that must never be touched.
  cf.d1.push({ uuid: "d1-blog", name: "blog-db" }, { uuid: "d1-other", name: "blog-db-2" });
  cf.kv.push({ id: "kv-blog", title: "blog-cache" }, { id: "kv-shared", title: "shared" }, { id: "kv-other", title: "blog-cache-old" });
  cf.r2.push({ name: "blog-storage" }, { name: "blog-storage-2" });
  cf.secrets.set("blog", ["BETTER_AUTH_SECRET"]);
  cf.secrets.set("blog-2", []);
  out = [];
  err = [];
  timeline = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function exportHandler(code = 0) {
  return (call: ExecCall) => {
    timeline.push(`exec:${call.args.slice(0, 2).join(" ")}`);
    return { code };
  };
}

async function castraDestroy(args: string[], opts: { exportCode?: number; prompt?: (q: string) => Promise<string> } = {}) {
  const wrangler = fakeExec(exportHandler(opts.exportCode));
  const fetch = async (input: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "DELETE") timeline.push(`delete:${new URL(input).pathname.split("/").slice(-2).join("/")}`);
    return cf.fetch(input, init);
  };
  const code = await run(["destroy", ...args], {
    cwd: dir,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    fetch,
    exec: wrangler.exec,
    env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: "acc1" },
    prompt: opts.prompt,
  });
  return { code, execCalls: wrangler.calls };
}

const deletes = () => cf.calls.filter((c) => c.method === "DELETE");

describe("castra destroy (ADR 0076)", () => {
  it("--dry-run lists exactly the recorded resources and deletes nothing", async () => {
    const { code, execCalls } = await castraDestroy(["--dry-run"]);
    expect(code).toBe(0);
    const plan = out.join("\n");
    expect(plan).toContain("Worker blog");
    expect(plan).toContain("D1 database blog-db (d1-blog)");
    expect(plan).toContain("KV namespace blog-cache (kv-blog)");
    expect(plan).toContain("R2 bucket blog-storage");
    expect(plan).toContain("Kept (not created by Castra): KV SHARED");
    for (const other of ["blog-db-2", "blog-cache-old", "blog-storage-2", "blog-2", "kv-shared"]) {
      expect(plan).not.toMatch(new RegExp(`- .*${other}\\b`));
    }
    expect(plan).toContain("Dry run: nothing was deleted.");
    expect(deletes()).toEqual([]);
    expect(execCalls).toEqual([]);
  });

  it("refuses without a terminal and without --confirm", async () => {
    const { code, execCalls } = await castraDestroy([]);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--confirm blog");
    expect(deletes()).toEqual([]);
    expect(execCalls).toEqual([]);
  });

  it("refuses when the typed or passed name does not match", async () => {
    expect((await castraDestroy([], { prompt: async () => "blog-2" })).code).toBe(1);
    expect((await castraDestroy(["--confirm", "Blog"])).code).toBe(1);
    expect(deletes()).toEqual([]);
  });

  it("exports D1, then deletes Worker, KV, R2, D1 in order, and resets the recorded ids", async () => {
    const { code, execCalls } = await castraDestroy([], { prompt: async () => "blog\n" });
    expect(code).toBe(0);
    expect(timeline).toEqual([
      "exec:d1 export",
      "delete:scripts/blog",
      "delete:namespaces/kv-blog",
      "delete:buckets/blog-storage",
      "delete:database/d1-blog",
    ]);
    const exp = execCalls[0]!;
    expect(exp.args.slice(0, 5)).toEqual(["d1", "export", "blog-db", "--remote", "--output"]);
    expect(exp.args[5]).toMatch(/castra-backups[/\\]blog-db-.+\.sql$/);
    expect(exp.options.env).toEqual({ CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: "acc1" });

    // Look-alikes survive.
    expect(cf.d1.map((d) => d.name)).toEqual(["blog-db-2"]);
    expect(cf.kv.map((n) => n.id)).toEqual(["kv-shared", "kv-other"]);
    expect(cf.r2.map((b) => b.name)).toEqual(["blog-storage-2"]);
    expect([...cf.secrets.keys()]).toEqual(["blog-2"]);

    const text = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    expect(text).toContain("// the blog");
    expect(text).toContain(`"database_id": "${PLACEHOLDER_ID}"`);
    expect(text).toContain(`{ "binding": "CACHE", "id": "${PLACEHOLDER_ID}" }`);
    expect(text).toContain('"id": "kv-shared"');
    expect(text).toContain('"bucket_name": "blog-storage"');
  });

  it("is idempotent: a second run has nothing to delete", async () => {
    expect((await castraDestroy(["--confirm", "blog"])).code).toBe(0);
    cf.calls = [];
    out = [];
    const { code, execCalls } = await castraDestroy(["--confirm", "blog"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Nothing to delete for blog");
    expect(deletes()).toEqual([]);
    expect(execCalls).toEqual([]);
  });

  it("a failed export deletes nothing", async () => {
    const { code } = await castraDestroy(["--confirm", "blog"], { exportCode: 1 });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Nothing was deleted");
    expect(deletes()).toEqual([]);
  });

  it("a non-empty R2 bucket stops the run before D1; a rerun continues", async () => {
    cf.r2NonEmpty.add("blog-storage");
    expect((await castraDestroy(["--confirm", "blog"])).code).toBe(1);
    expect(err.join("\n")).toContain("Empty the bucket");
    expect(cf.d1.some((d) => d.uuid === "d1-blog")).toBe(true);
    expect(cf.secrets.has("blog")).toBe(false);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toContain('"database_id": "d1-blog"');

    cf.r2NonEmpty.clear();
    timeline = [];
    expect((await castraDestroy(["--confirm", "blog"])).code).toBe(0);
    expect(timeline).toEqual(["exec:d1 export", "delete:buckets/blog-storage", "delete:database/d1-blog"]);
  });

  it("refuses when database_id points at a database with another name", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), CONFIG.replace('"database_id": "d1-blog"', '"database_id": "d1-other"'));
    const { code } = await castraDestroy(["--confirm", "blog"]);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain('is the database "blog-db-2", not "blog-db"');
    expect(deletes()).toEqual([]);
  });

  it("--skip-backup says so in the plan and runs no export", async () => {
    const { code, execCalls } = await castraDestroy(["--confirm", "blog", "--skip-backup"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("will NOT be exported");
    expect(execCalls).toEqual([]);
  });

  it("placeholder ids and a missing Worker mean nothing to delete", async () => {
    await writeFile(
      join(dir, "wrangler.jsonc"),
      `{ "name": "fresh", "d1_databases": [{ "binding": "DB", "database_name": "fresh-db", "database_id": "${PLACEHOLDER_ID}" }] }`,
    );
    const { code } = await castraDestroy(["--confirm", "fresh"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Nothing to delete for fresh");
    expect(deletes()).toEqual([]);
  });

  it("a missing permission is reported as a problem and nothing is deleted", async () => {
    cf.denied.add("d1");
    const { code } = await castraDestroy(["--confirm", "blog"]);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain('Missing token permission "D1 Edit"');
    expect(deletes()).toEqual([]);
  });
});
