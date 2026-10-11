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

describe("design notes (not failing tests)", () => {
  it.todo(
    "R5-4 spawnExec: child.stdin has no 'error' listener; an EPIPE (child exits before reading stdin) is an unhandled " +
      "error that crashes the CLI. Not reachable with today's inputs (43-byte secret, empty stdin), reproducible with a large input.",
  );
  it.todo(
    "R5-5 deploy/migrate: wrangler steps take CLOUDFLARE_API_TOKEN from process.env, provision/drift from deps.env; " +
      "programmatic callers passing a different env get two different identities.",
  );
  it.todo(
    "R5-6 provision: a real D1 database_id whose database_name differs is silently repointed to a NEW empty database " +
      "(warning only, ADR 0030); KV prefers the configured id. Consider refusing instead of repointing.",
  );
  it.todo("R5-7 run(): CliError is exit 2 ('usage') but is also thrown for runtime problems (config not found, unprovisioned binding).");
});
