/**
 * M5 review (CLI). Each `it` below demonstrates a confirmed defect and is expected to FAIL until it is fixed.
 * `it.todo` entries are design-level notes, not failing tests. See the M5 review report (R5-N ids).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "../src/commands/doctor.js";
import type { DoctorCheck } from "../src/commands/doctor.js";
import { provision } from "../src/commands/provision.js";
import { ProblemError } from "../src/problems.js";
import { run } from "../src/run.js";
import type { FetchFn } from "../src/cloudflare/api.js";
import { FAKE_TOKEN, FakeCloudflare, forbidRealNetwork } from "./fake-cloudflare.js";
import { BLOG_CONFIG, PROVISIONED_CONFIG } from "./fixtures.js";

forbidRealNetwork();

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

let dir: string;
let cf: FakeCloudflare;
let out: string[];
let err: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "castra-review5-"));
  cf = new FakeCloudflare();
  out = [];
  err = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const EDIT_GROUPS = ["Workers Scripts Edit", "D1 Edit", "Workers KV Storage Edit"];

/**
 * Wraps the fake so `GET /user/tokens/tok1` returns the given policies verbatim (with `resources`, as the real
 * API does); every other call goes to the fake.
 */
function withPolicies(policies: unknown[]): FetchFn {
  return async (input, init) => {
    const url = new URL(input);
    if ((init?.method ?? "GET") === "GET" && url.pathname === "/client/v4/user/tokens/tok1") {
      return Response.json({ success: true, errors: [], messages: [], result: { id: "tok1", status: "active", policies } });
    }
    return cf.fetch(input, init);
  };
}

const runDoctor = (fetch: FetchFn) =>
  doctor(
    { cwd: dir, config: "wrangler.jsonc" },
    {
      fetch,
      env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: "acc1" },
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      openDatabase: async () => {
        throw new Error("no local D1 in this test");
      },
    },
  );

const row = (checks: DoctorCheck[], name: string) => checks.find((c) => c.check === name);

describe("R5-1 doctor trusts the token's policy list without checking account scope or deny", () => {
  it("R5-1a: Edit groups granted only on ANOTHER account are not reported as ok for the target account", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), PROVISIONED_CONFIG);
    // The target account (acc1) refuses everything; the token's Edit rows are scoped to a different account.
    cf.denied.add("workers");
    cf.denied.add("d1");
    cf.denied.add("kv");
    const fetch = withPolicies([
      {
        id: "p1",
        effect: "allow",
        resources: { "com.cloudflare.api.account.other-account": "*" },
        permission_groups: EDIT_GROUPS.map((name, i) => ({ id: `g${i}`, name })),
      },
    ]);
    const { code, checks } = await runDoctor(fetch);
    // Today: all three rows are "ok" and doctor exits 0, although every call to acc1 is refused (403).
    expect(row(checks, "D1 Edit")?.status).not.toBe("ok");
    expect(code).toBe(1);
  });

  it("R5-1b: a deny policy for an Edit group overrides an allow policy for it", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), PROVISIONED_CONFIG);
    cf.denied.add("d1");
    const fetch = withPolicies([
      {
        id: "p1",
        effect: "allow",
        resources: { "com.cloudflare.api.account.acc1": "*" },
        permission_groups: EDIT_GROUPS.map((name, i) => ({ id: `g${i}`, name })),
      },
      {
        id: "p2",
        effect: "deny",
        resources: { "com.cloudflare.api.account.acc1": "*" },
        permission_groups: [{ id: "gd", name: "D1 Edit" }],
      },
    ]);
    const { code, checks } = await runDoctor(fetch);
    // Today: "D1 Edit" is "ok" (deny policies are skipped) and doctor exits 0.
    expect(row(checks, "D1 Edit")?.status).not.toBe("ok");
    expect(code).toBe(1);
  });
});

describe("R5-2 R2 bucket name derived from a valid long Worker name exceeds R2's 63-character limit", () => {
  it("provision --storage never asks Cloudflare for a bucket name longer than 63 characters", async () => {
    // 60 characters: a valid Worker name (create-castra accepts up to 63).
    const worker = `a${"b".repeat(58)}c`;
    expect(worker).toHaveLength(60);
    await writeFile(join(dir, "wrangler.jsonc"), BLOG_CONFIG.replace(`"name": "castra-blog"`, `"name": "${worker}"`));
    await provision(
      { cwd: dir, config: "wrangler.jsonc", storage: true },
      { fetch: cf.fetch, env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN }, log: (l) => out.push(l), error: (l) => err.push(l) },
    );
    const bucketPost = cf.posts.find((c) => c.path.endsWith("/r2/buckets"));
    expect(bucketPost).toBeDefined();
    // R2: "Bucket names ... can only be between 3-63 characters in length". Today the name is 68 characters.
    expect(String((bucketPost!.body as { name: string }).name).length).toBeLessThanOrEqual(63);
  });
});

describe("R5-3 CI does not run on pushes to the default branch", () => {
  it("the workflow's push trigger includes master (origin/HEAD -> master)", async () => {
    const ci = await readFile(join(REPO, ".github/workflows/ci.yml"), "utf8");
    const push = /push:\s*\n\s*branches:\s*\[([^\]]*)\]/.exec(ci)?.[1] ?? "";
    // Today: `branches: [main]`; the repository's default branch is `master`, so merges never run CI.
    expect(push.split(",").map((s) => s.trim())).toContain("master");
  });
});

describe("R5-6 provision refuses a real D1 database_id that is not the named database", () => {
  const D1_ID = "11111111-2222-3333-4444-555555555555";
  const config = () => BLOG_CONFIG.replace(/"database_id": "[^"]*"/, `"database_id": "${D1_ID}"`);
  const runProvision = () =>
    provision(
      { cwd: dir, config: "wrangler.jsonc" },
      { fetch: cf.fetch, env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN }, log: (l) => out.push(l), error: (l) => err.push(l) },
    );

  it("no database with that name: refuses instead of creating a new empty one; nothing is written", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), config());
    await expect(runProvision()).rejects.toMatchObject({ type: "d1-id-mismatch" });
    expect(cf.posts).toEqual([]);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(config());
  });

  it("the name belongs to another database: refuses with both ids and how to resolve it", async () => {
    cf.d1.push({ uuid: "other-uuid", name: "castra-blog" });
    await writeFile(join(dir, "wrangler.jsonc"), config());
    const e = await runProvision().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProblemError);
    const problem = e as ProblemError;
    expect(problem.detail).toContain(D1_ID);
    expect(problem.detail).toContain("other-uuid");
    expect(problem.fix).toMatch(/database_name/);
    expect(problem.fix).toMatch(/00000000-0000-0000-0000-000000000000/);
    expect(cf.posts).toEqual([]);
  });

  it("the configured id IS the named database: accepted unchanged", async () => {
    cf.d1.push({ uuid: D1_ID, name: "castra-blog" });
    await writeFile(join(dir, "wrangler.jsonc"), config());
    const result = await runProvision();
    expect(result.resources.find((r) => r.kind === "d1")).toMatchObject({ id: D1_ID, created: false });
  });

  it("exit code via run(): 1 (a problem, not a usage error)", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), config());
    const code = await run(["provision"], {
      cwd: dir,
      fetch: cf.fetch,
      env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN },
      log: (l) => out.push(l),
      error: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("d1-id-mismatch");
  });
});

describe("R5-7 run() exit codes: runtime CliError is 1, usage error is 2", () => {
  const castra = (argv: string[]) =>
    run(argv, {
      cwd: dir,
      fetch: cf.fetch,
      env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: "acc1" },
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      openDatabase: async () => {
        throw new Error("no database");
      },
    });

  it("config not found: exit 1", async () => {
    expect(await castra(["provision", "--config", "missing.jsonc"])).toBe(1);
    expect(err.join("\n")).toContain("Wrangler config not found");
    expect(await castra(["migrate", "--config", "missing.jsonc"])).toBe(1);
  });

  it("unprovisioned binding: exit 1", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), BLOG_CONFIG); // placeholder database_id
    expect(await castra(["mcp", "token", "revoke", "t1", "--remote"])).toBe(1);
    expect(err.join("\n")).toContain("castra provision");
  });

  it("bad flags and conflicting arguments: exit 2", async () => {
    expect(await castra(["provision", "--bogus"])).toBe(2);
    expect(await castra(["migrate", "--local", "--remote"])).toBe(2);
    expect(await castra(["test", "unit"])).toBe(2);
  });
});
