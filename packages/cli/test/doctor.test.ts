import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueryFn } from "castra";
import { doctor } from "../src/commands/doctor.js";
import type { DoctorCheck } from "../src/commands/doctor.js";
import { run } from "../src/run.js";
import type { OpenDatabaseFn } from "../src/local-d1.js";
import { FAKE_TOKEN, FakeCloudflare, forbidRealNetwork } from "./fake-cloudflare.js";
import { BLOG_CONFIG, PROVISIONED_CONFIG as PROVISIONED } from "./fixtures.js";

forbidRealNetwork();

let dir: string;
let cf: FakeCloudflare;
let out: string[];
let err: string[];

const noDb: OpenDatabaseFn = async () => {
  throw new Error("doctor should not open a database without local state");
};

const runDoctor = (opts: { env?: Record<string, string>; storage?: boolean; openDatabase?: OpenDatabaseFn } = {}) =>
  doctor(
    { cwd: dir, config: "wrangler.jsonc", storage: opts.storage },
    {
      fetch: cf.fetch,
      env: opts.env ?? { CLOUDFLARE_API_TOKEN: FAKE_TOKEN },
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      openDatabase: opts.openDatabase ?? noDb,
    },
  );

const row = (checks: DoctorCheck[], name: string) => checks.find((c) => c.check === name);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "castra-doctor-"));
  await writeFile(join(dir, "wrangler.jsonc"), PROVISIONED);
  cf = new FakeCloudflare();
  out = [];
  err = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("castra doctor", () => {
  it("passes with a valid token, all permissions and provisioned bindings", async () => {
    const { code, checks } = await runDoctor();
    expect(code).toBe(0);
    expect(row(checks, "Workers Scripts Edit")?.status).toBe("readable");
    expect(row(checks, "D1 Edit")?.status).toBe("readable");
    expect(row(checks, "Workers KV Storage Edit")?.status).toBe("readable");
    expect(row(checks, "Workers R2 Storage Edit")).toBeUndefined();
    expect(row(checks, "D1 binding DB")?.status).toBe("ok");
    expect(row(checks, "KV binding CACHE")?.status).toBe("ok");
    expect(out[0]).toMatch(/^Check\s+Status\s+How to fix$/);
    expect(out.join("\n")).toContain("All required checks passed.");
  });

  it("is read-only: never POSTs, PUTs or DELETEs", async () => {
    await runDoctor({ storage: true });
    expect(cf.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("reports each missing permission with a fix and exits 1", async () => {
    cf.denied.add("d1");
    cf.denied.add("kv");
    const { code, checks } = await runDoctor();
    expect(code).toBe(1);
    expect(row(checks, "D1 Edit")).toMatchObject({ status: "missing" });
    expect(row(checks, "D1 Edit")!.fix).toContain("Account > D1 Edit");
    expect(row(checks, "Workers KV Storage Edit")?.status).toBe("missing");
    expect(row(checks, "Workers Scripts Edit")?.status).toBe("readable");
    expect(err.join("\n")).toContain("Missing: D1 Edit, Workers KV Storage Edit");
  });

  it("requires R2 only with storage", async () => {
    cf.denied.add("r2");
    expect((await runDoctor()).code).toBe(0);
    const { code, checks } = await runDoctor({ storage: true });
    expect(code).toBe(1);
    expect(row(checks, "Workers R2 Storage Edit")?.status).toBe("missing");
  });

  it("uses the token's own policies when readable to distinguish Read from Edit", async () => {
    cf.policyNames = ["Workers Scripts Write", "D1 Read", "Workers KV Storage Edit"];
    const { code, checks } = await runDoctor();
    expect(code).toBe(1);
    expect(row(checks, "Workers Scripts Edit")?.status).toBe("ok");
    expect(row(checks, "Workers KV Storage Edit")?.status).toBe("ok");
    expect(row(checks, "D1 Edit")).toMatchObject({ status: "missing" });
    expect(row(checks, "D1 Edit")!.fix).toContain("only D1 Read");
  });

  it("reports a missing token and still checks bindings", async () => {
    const { code, checks } = await runDoctor({ env: {} });
    expect(code).toBe(1);
    expect(row(checks, "API token / account")?.fix).toContain("Missing Cloudflare API token");
    expect(row(checks, "D1 Edit")?.status).toBe("skipped");
    expect(row(checks, "D1 binding DB")?.status).toBe("ok");
    expect(cf.calls).toEqual([]);
  });

  it("reports an invalid token", async () => {
    cf.tokenValid = false;
    const { code, checks } = await runDoctor();
    expect(code).toBe(1);
    expect(row(checks, "API token / account")?.fix).toContain("Invalid Cloudflare API token");
  });

  it("warns (without failing) about placeholder bindings", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), BLOG_CONFIG);
    const { code, checks } = await runDoctor();
    expect(code).toBe(0);
    expect(row(checks, "D1 binding DB")).toMatchObject({ status: "warn" });
    expect(row(checks, "KV binding CACHE")!.fix).toContain("castra provision");
  });

  it("runs the drift check when a local D1 exists and fails on drift", async () => {
    await mkdir(join(dir, ".wrangler", "state", "v3", "d1"), { recursive: true });
    const query: QueryFn = async (sql) => {
      if (sql.startsWith("SELECT name FROM sqlite_master")) return [{ name: "notes" }];
      if (sql === 'PRAGMA table_info("notes")') {
        return [{ cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 }];
      }
      return [];
    };
    const open: OpenDatabaseFn = async () => ({ query, close: async () => {} });

    // No committed snapshot -> drift.
    const first = await runDoctor({ openDatabase: open });
    expect(first.code).toBe(1);
    expect(row(first.checks, "Schema snapshot (local D1)")?.status).toBe("missing");

    // After `castra generate` the snapshot matches.
    expect(await run(["generate"], { cwd: dir, log: () => {}, error: () => {}, openDatabase: open })).toBe(0);
    const second = await runDoctor({ openDatabase: open });
    expect(row(second.checks, "Schema snapshot (local D1)")?.status).toBe("ok");
    expect(second.code).toBe(0);
  });

  it("is wired into the CLI and returns the exit code", async () => {
    cf.denied.add("workers");
    const code = await run(["doctor"], {
      cwd: dir,
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      fetch: cf.fetch,
      env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN },
      openDatabase: noDb,
    });
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/Workers Scripts Edit\s+missing/);
  });
});
