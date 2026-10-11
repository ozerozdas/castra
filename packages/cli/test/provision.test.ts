import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultBucketName } from "../src/commands/provision.js";
import { run } from "../src/run.js";
import { isPlaceholderId, readWranglerConfig, setJsoncValue } from "../src/wrangler-config.js";
import { FAKE_TOKEN, FakeCloudflare, fakeExec, forbidRealNetwork } from "./fake-cloudflare.js";

import { BLOG_CONFIG } from "./fixtures.js";

forbidRealNetwork();

let dir: string;
let cf: FakeCloudflare;
let out: string[];
let err: string[];

const castra = (argv: string[], env: Record<string, string | undefined> = { CLOUDFLARE_API_TOKEN: FAKE_TOKEN }) =>
  run(argv, {
    cwd: dir,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    fetch: cf.fetch,
    exec: fakeExec().exec,
    env,
    openDatabase: async () => {
      throw new Error("no database in provision tests");
    },
  });

const configText = () => readFile(join(dir, "wrangler.jsonc"), "utf8");
const configJson = async () => parse(await configText(), [], { allowTrailingComma: true });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "castra-provision-"));
  await writeFile(join(dir, "wrangler.jsonc"), BLOG_CONFIG);
  cf = new FakeCloudflare();
  out = [];
  err = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("castra provision", () => {
  it("creates D1 and KV when missing and writes the ids, preserving comments and formatting", async () => {
    expect(await castra(["provision"])).toBe(0);
    expect(err).toEqual([]);

    expect(cf.posts.map((c) => c.path)).toEqual(["/accounts/acc1/d1/database", "/accounts/acc1/storage/kv/namespaces"]);
    expect(cf.posts[0]!.body).toEqual({ name: "castra-blog" });
    expect(cf.posts[1]!.body).toEqual({ title: "castra-blog-cache" });

    const text = await configText();
    expect(text).toContain("// Placeholder for local development only.");
    expect(text).toContain(`"compatibility_flags": ["nodejs_compat"],`);
    expect(text).toContain(`"database_id": "${cf.d1[0]!.uuid}"`);
    const json = await configJson();
    expect(json.kv_namespaces).toEqual([{ binding: "CACHE", id: cf.kv[0]!.id }]);
    // Untouched lines stay byte-identical.
    expect(text.startsWith(BLOG_CONFIG.split("\n").slice(0, 7).join("\n"))).toBe(true);
  });

  it("is idempotent: a second run makes zero create calls and does not rewrite the file", async () => {
    expect(await castra(["provision"])).toBe(0);
    const first = await configText();
    cf.calls = [];
    out = [];

    expect(await castra(["provision"])).toBe(0);
    expect(cf.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(await configText()).toBe(first);
    expect(out.join("\n")).toContain("All resources already provisioned");
  });

  it("adopts existing resources found by name instead of creating them", async () => {
    cf.d1.push({ uuid: "existing-d1", name: "castra-blog" }, { uuid: "other", name: "castra-blog-old" });
    cf.kv.push({ id: "existingkv0000000000000000000000", title: "castra-blog-cache" });
    expect(await castra(["provision"])).toBe(0);
    expect(cf.posts).toEqual([]);
    const json = await configJson();
    expect(json.d1_databases[0].database_id).toBe("existing-d1");
    expect(json.kv_namespaces[0].id).toBe("existingkv0000000000000000000000");
  });

  it("appends CACHE to an existing kv_namespaces array and keeps other namespaces", async () => {
    const withKv = BLOG_CONFIG.replace(
      `  "d1_databases": [`,
      `  "kv_namespaces": [{ "binding": "OTHER", "id": "abc" }],\n  "d1_databases": [`,
    );
    await writeFile(join(dir, "wrangler.jsonc"), withKv);
    expect(await castra(["provision"])).toBe(0);
    const json = await configJson();
    expect(json.kv_namespaces.map((k: { binding: string }) => k.binding)).toEqual(["OTHER", "CACHE"]);
  });

  it("creates the R2 bucket only with --storage, and is idempotent for it too", async () => {
    expect(await castra(["provision"])).toBe(0);
    expect(cf.calls.some((c) => c.path.includes("/r2/"))).toBe(false);

    expect(await castra(["provision", "--storage"])).toBe(0);
    expect(cf.r2).toEqual([{ name: "castra-blog-storage" }]);
    expect((await configJson()).r2_buckets).toEqual([{ binding: "STORAGE", bucket_name: "castra-blog-storage" }]);

    cf.calls = [];
    // r2_buckets now in the config: storage stays on without the flag, and nothing is created.
    expect(await castra(["provision"])).toBe(0);
    expect(cf.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(cf.calls.some((c) => c.path.includes("/r2/buckets"))).toBe(true);
  });

  it("uses CLOUDFLARE_ACCOUNT_ID / --account-id without listing accounts", async () => {
    cf.accounts.push({ id: "acc2", name: "Second" });
    expect(await castra(["provision", "--account-id", "acc2"])).toBe(0);
    expect(cf.calls.some((c) => c.path.startsWith("/accounts?"))).toBe(false);
    expect(cf.posts[0]!.path).toBe("/accounts/acc2/d1/database");
  });

  it("verifies account-owned tokens through the account endpoint", async () => {
    cf.tokenKind = "account";
    expect(await castra(["provision"], { CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: "acc1" })).toBe(0);
    expect(cf.calls.map((c) => c.path)).toContain("/accounts/acc1/tokens/verify");
  });
});

describe("derived resource names (R5-2)", () => {
  const R2_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

  it("keeps <worker>-storage when it fits R2's rules", () => {
    expect(defaultBucketName("castra-blog")).toBe("castra-blog-storage");
    expect(defaultBucketName("a".repeat(55))).toBe(`${"a".repeat(55)}-storage`);
  });

  it("truncates long Worker names with a stable hash suffix, always a valid 3-63 char bucket name", () => {
    for (const worker of ["a".repeat(56), `a${"b".repeat(58)}c`, `x${"-y".repeat(31)}`, "z".repeat(63)]) {
      const name = defaultBucketName(worker);
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(R2_NAME);
      expect(name).toMatch(/-[0-9a-f]{8}-storage$/);
      expect(defaultBucketName(worker)).toBe(name); // deterministic
    }
    // Two long names sharing a prefix do not collide.
    expect(defaultBucketName(`${"a".repeat(60)}x`)).not.toBe(defaultBucketName(`${"a".repeat(60)}y`));
  });

  it("sanitizes characters R2 does not allow", () => {
    expect(defaultBucketName("My_App")).toMatch(/^my-app-[0-9a-f]{8}-storage$/);
  });

  it("provision --storage with a long Worker name is idempotent", async () => {
    const worker = "w".repeat(60);
    await writeFile(join(dir, "wrangler.jsonc"), BLOG_CONFIG.replace(`"name": "castra-blog"`, `"name": "${worker}"`));
    expect(await castra(["provision", "--storage"])).toBe(0);
    expect(cf.r2).toEqual([{ name: defaultBucketName(worker) }]);
    expect((await configJson()).r2_buckets[0].bucket_name).toBe(defaultBucketName(worker));
    cf.calls = [];
    expect(await castra(["provision", "--storage"])).toBe(0);
    expect(cf.posts).toEqual([]);
    // D1 (no documented name limit) and KV titles (max 512) keep the plain derivation.
    expect(cf.kv[0]!.title).toBe(`${worker}-cache`);
  });
});

describe("provision errors (problem-style, exit 1, nothing written)", () => {
  it("missing token", async () => {
    expect(await castra(["provision"], {})).toBe(1);
    expect(err[0]).toBe("error[missing-token]: Missing Cloudflare API token");
    expect(err.join("\n")).toContain("fix:");
    expect(cf.calls).toEqual([]);
    expect(await configText()).toBe(BLOG_CONFIG);
  });

  it("invalid token", async () => {
    cf.tokenValid = false;
    expect(await castra(["provision"])).toBe(1);
    expect(err[0]).toContain("error[invalid-token]");
    expect(err.join("\n")).toContain("Invalid API Token");
  });

  it("account API token without an account id is refused before any call", async () => {
    expect(await castra(["provision"], { CLOUDFLARE_API_TOKEN: "cfat_abc" })).toBe(1);
    expect(err[0]).toBe("error[account-token-needs-account-id]: Account API token needs an account id");
    expect(err.join("\n")).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(cf.calls).toEqual([]);
  });

  it("global API key is refused before any call", async () => {
    expect(await castra(["provision"], { CLOUDFLARE_API_TOKEN: "cfk_abc", CLOUDFLARE_ACCOUNT_ID: "acc1" })).toBe(1);
    expect(err[0]).toBe("error[global-api-key]: Global API Key is not supported");
    expect(cf.calls).toEqual([]);
  });

  it("inactive token", async () => {
    cf.tokenStatus = "expired";
    expect(await castra(["provision"])).toBe(1);
    expect(err[0]).toContain("error[inactive-token]");
  });

  it("multiple accounts lists them", async () => {
    cf.accounts.push({ id: "acc2", name: "Second" });
    expect(await castra(["provision"])).toBe(1);
    expect(err[0]).toContain("error[multiple-accounts]");
    expect(err.join("\n")).toContain("acc1 (Test Account), acc2 (Second)");
    expect(err.join("\n")).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("missing permission names the exact permission group", async () => {
    cf.denied.add("kv");
    expect(await castra(["provision"])).toBe(1);
    expect(err[0]).toBe(`error[missing-permission]: Missing token permission "Workers KV Storage Edit"`);
    expect(await configText()).toBe(BLOG_CONFIG);
  });

  it("missing D1 permission", async () => {
    cf.denied.add("d1");
    expect(await castra(["provision"])).toBe(1);
    expect(err[0]).toContain(`"D1 Edit"`);
  });

  it("missing R2 permission only matters with storage", async () => {
    cf.denied.add("r2");
    expect(await castra(["provision"])).toBe(0);
    expect(await castra(["provision", "--storage"])).toBe(1);
    expect(err.join("\n")).toContain(`"Workers R2 Storage Edit"`);
  });
});

describe("wrangler config helpers", () => {
  it("recognises placeholder ids", () => {
    expect(isPlaceholderId("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(isPlaceholderId("00000000000000000000000000000000")).toBe(true);
    expect(isPlaceholderId("")).toBe(true);
    expect(isPlaceholderId(undefined)).toBe(true);
    expect(isPlaceholderId("6f1c0a3e-0000-4000-8000-000000000001")).toBe(false);
  });

  it("reads bindings with their indexes", () => {
    const c = readWranglerConfig(BLOG_CONFIG);
    expect(c.name).toBe("castra-blog");
    expect(c.d1).toEqual([
      {
        index: 0,
        binding: "DB",
        databaseName: "castra-blog",
        databaseId: "00000000-0000-0000-0000-000000000000",
        migrationsDir: "migrations",
      },
    ]);
    expect(c.kv).toEqual([]);
  });

  it("keeps tab indentation when inserting", () => {
    const tabbed = `{\n\t"name": "x",\n\t// keep me\n\t"d1_databases": []\n}\n`;
    const next = setJsoncValue(tabbed, ["kv_namespaces"], [{ binding: "CACHE", id: "1" }]);
    expect(next).toContain("// keep me");
    expect(next).toMatch(/\n\t"kv_namespaces"/);
  });
});
