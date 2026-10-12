import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueryFn } from "@castra-kit/core";
import { doctor, grantedGroupNames, policyCoversAccount } from "../src/commands/doctor.js";
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

const runDoctor = (opts: { env?: Record<string, string>; storage?: boolean; remote?: boolean; openDatabase?: OpenDatabaseFn } = {}) =>
  doctor(
    { cwd: dir, config: "wrangler.jsonc", storage: opts.storage, remote: opts.remote },
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

  it("with --remote, checks drift against the deployed D1 over the API and returns the drift lines (ADR 0079)", async () => {
    cf.d1Query = (sql) => {
      if (sql.startsWith("SELECT name FROM sqlite_master")) return [{ name: "notes" }];
      if (sql === 'PRAGMA table_info("notes")') return [{ cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 }];
      return [];
    };
    const open: OpenDatabaseFn = async () => ({ query: async (sql, params) => cf.d1Query(sql, params ?? []), close: async () => {} });
    expect(await run(["generate"], { cwd: dir, log: () => {}, error: () => {}, openDatabase: open })).toBe(0);
    const same = await runDoctor({ remote: true });
    expect(row(same.checks, "Schema snapshot (remote D1)")?.status).toBe("ok");
    expect(cf.calls.some((c) => c.path.endsWith("/d1/database/6f1c0a3e-1111-4000-8000-000000000001/query"))).toBe(true);

    cf.d1Query = () => []; // the deployed database has no tables
    const drifted = await runDoctor({ remote: true });
    expect(drifted.code).toBe(1);
    expect(row(drifted.checks, "Schema snapshot (remote D1)")).toMatchObject({ status: "missing" });
    expect(row(drifted.checks, "Schema snapshot (remote D1)")!.fix).toContain("castra migrate --remote");
    expect(drifted.drift.join("\n")).toContain("notes");
  });

  it("skips remote drift until the database is provisioned or the token works", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), BLOG_CONFIG);
    expect(row((await runDoctor({ remote: true })).checks, "Schema snapshot (remote D1)")).toMatchObject({ status: "skipped" });
    await writeFile(join(dir, "wrangler.jsonc"), PROVISIONED);
    expect(row((await runDoctor({ remote: true, env: {} })).checks, "Schema snapshot (remote D1)")?.fix).toBe("Fix the token first.");
  });

  it("warns about missing rate-limit bindings without failing (ADR 0079)", async () => {
    const without = await runDoctor();
    expect(without.code).toBe(0);
    expect(row(without.checks, "Rate limit binding AUTH_RATE_LIMITER")).toMatchObject({ status: "warn", required: false });
    expect(row(without.checks, "Rate limit binding AUTH_RATE_LIMITER")!.fix).toContain('"namespace_id": "1002"');
    await writeFile(
      join(dir, "wrangler.jsonc"),
      PROVISIONED.replace(`  "d1_databases": [`, `  "ratelimits": [{ "name": "RATE_LIMITER" }, { "name": "AUTH_RATE_LIMITER" }],\n  "d1_databases": [`),
    );
    const withBoth = await runDoctor();
    expect(row(withBoth.checks, "Rate limit binding RATE_LIMITER")?.status).toBe("ok");
    expect(row(withBoth.checks, "Rate limit binding AUTH_RATE_LIMITER")?.status).toBe("ok");
  });

  it("fails on mixed @castra-kit/* versions, passes when aligned, warns when not installed (ADR 0079)", async () => {
    const install = async (versions: Record<string, string>) => {
      for (const [name, version] of Object.entries(versions)) {
        await mkdir(join(dir, "node_modules", name), { recursive: true });
        await writeFile(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
      }
    };
    expect(row((await runDoctor()).checks, "Castra packages")).toBeUndefined(); // no package.json
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@castra-kit/app": "^0.2.0", hono: "4" }, devDependencies: { "@castra-kit/cli": "^0.2.0" } }),
    );
    expect(row((await runDoctor()).checks, "Castra packages")).toMatchObject({ status: "warn", required: false });

    await install({ "@castra-kit/app": "0.2.0", "@castra-kit/cli": "0.1.2" });
    const mixed = await runDoctor();
    expect(mixed.code).toBe(1);
    expect(row(mixed.checks, "Castra packages")!.fix).toContain("pnpm add @castra-kit/app@0.2.0 @castra-kit/cli@0.2.0");

    await install({ "@castra-kit/cli": "0.2.0" });
    const aligned = await runDoctor();
    expect(row(aligned.checks, "Castra packages (0.2.0)")?.status).toBe("ok");
    expect(aligned.code).toBe(0);
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

describe("token policy evaluation (R5-1)", () => {
  const groups = (...names: string[]) => names.map((name, i) => ({ id: `g${i}`, name }));

  it("counts allow policies on the account id or the all-accounts wildcard only", () => {
    expect(policyCoversAccount({ "com.cloudflare.api.account.acc1": "*" }, "acc1")).toBe(true);
    expect(policyCoversAccount({ "com.cloudflare.api.account.*": "*" }, "acc1")).toBe(true);
    expect(policyCoversAccount({ "com.cloudflare.api.account.acc2": "*" }, "acc1")).toBe(false);
    // Zones inside the account (nested object) or all zones: not the account itself.
    expect(policyCoversAccount({ "com.cloudflare.api.account.acc1": { "com.cloudflare.api.account.zone.*": "*" } }, "acc1")).toBe(false);
    expect(policyCoversAccount({ "com.cloudflare.api.account.zone.*": "*" }, "acc1")).toBe(false);
    expect(policyCoversAccount({ "com.cloudflare.api.user.u1": "*" }, "acc1")).toBe(false);
    expect(policyCoversAccount(undefined, "acc1")).toBe(false);
  });

  it("removes groups denied on the account, ignores denies scoped elsewhere", () => {
    const acc1 = { "com.cloudflare.api.account.acc1": "*" };
    const all = { "com.cloudflare.api.account.*": "*" };
    const other = { "com.cloudflare.api.account.acc2": "*" };
    const granted = grantedGroupNames(
      [
        { effect: "allow", resources: all, permission_groups: groups("D1 Edit", "Workers Scripts Edit", "Workers KV Storage Edit") },
        { effect: "deny", resources: acc1, permission_groups: groups("D1 Edit") },
        { effect: "deny", resources: other, permission_groups: groups("Workers Scripts Edit") },
        { effect: "allow", resources: other, permission_groups: groups("Workers R2 Storage Edit") },
      ],
      "acc1",
    );
    expect([...granted].sort()).toEqual(["Workers KV Storage Edit", "Workers Scripts Edit"]);
    // A deny on all accounts removes the group too.
    expect(
      grantedGroupNames(
        [
          { effect: "allow", resources: acc1, permission_groups: groups("D1 Edit") },
          { effect: "deny", resources: all, permission_groups: groups("D1 Edit") },
        ],
        "acc1",
      ).size,
    ).toBe(0);
  });

  it("allow: an Edit group granted on the target account is ok", async () => {
    cf.policyNames = ["Workers Scripts Edit", "D1 Edit", "Workers KV Storage Edit"];
    const { code, checks } = await runDoctor();
    expect(code).toBe(0);
    expect(row(checks, "D1 Edit")?.status).toBe("ok");
  });

  it("deny: a refused probe is missing even when the policies grant Edit", async () => {
    cf.policyNames = ["Workers Scripts Edit", "D1 Edit", "Workers KV Storage Edit"];
    cf.denied.add("kv");
    const { code, checks } = await runDoctor();
    expect(code).toBe(1);
    expect(row(checks, "Workers KV Storage Edit")?.status).toBe("missing");
    expect(row(checks, "D1 Edit")?.status).toBe("ok");
  });

  it("policies readable but silent about a group on this account: readable, not ok", async () => {
    cf.policyNames = ["Workers Scripts Edit", "D1 Edit"];
    const { code, checks } = await runDoctor();
    expect(code).toBe(0);
    expect(row(checks, "Workers KV Storage Edit")?.status).toBe("readable");
  });
});
