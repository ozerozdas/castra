import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueryFn } from "castra";
import { parseDeployedUrl } from "../src/commands/deploy.js";
import { run } from "../src/run.js";
import type { ExecCall } from "./fake-cloudflare.js";
import { FAKE_TOKEN, FakeCloudflare, fakeExec, forbidRealNetwork } from "./fake-cloudflare.js";
import { BLOG_CONFIG } from "./fixtures.js";

forbidRealNetwork();

/** Answers the statements `introspect` issues for a one-table schema. */
const schemaRows =
  (extraColumn: boolean) =>
  (sql: string, params: unknown[]): Record<string, unknown>[] => {
    if (sql.startsWith("SELECT name FROM sqlite_master")) return [{ name: "posts" }];
    if (sql.includes("pragma_table_info(?)") && params[0] === "posts") {
      return [
        { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
        { cid: 1, name: "title", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        ...(extraColumn ? [{ cid: 2, name: "extra", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 }] : []),
      ];
    }
    return [];
  };

const DEPLOY_OUTPUT = `Total Upload: 120.00 KiB / gzip: 30.00 KiB
Uploaded castra-blog (2.10 sec)
Deployed castra-blog triggers (0.50 sec)
  https://castra-blog.testsub.workers.dev
Current Version ID: 11111111-2222-3333-4444-555555555555`;

let dir: string;
let cf: FakeCloudflare;
let out: string[];
let err: string[];
let timeline: string[];
let execCalls: ExecCall[];

function wranglerHandler(overrides: { migrate?: number; deploy?: number; deployStdout?: string } = {}) {
  return (call: ExecCall) => {
    const sub = call.args.slice(0, 2).join(" ");
    timeline.push(`exec:${sub}`);
    if (sub === "d1 migrations") return { code: overrides.migrate ?? 0, stdout: "Migrations applied" };
    if (sub === "secret put") {
      // Mimic wrangler: creates the (draft) Worker if it does not exist, then stores the secret.
      const names = cf.secrets.get("castra-blog") ?? [];
      cf.secrets.set("castra-blog", [...names, call.args[2]!]);
      return { stdout: "Success! Uploaded secret BETTER_AUTH_SECRET" };
    }
    if (sub.startsWith("deploy")) return { code: overrides.deploy ?? 0, stdout: overrides.deployStdout ?? DEPLOY_OUTPUT };
    return {};
  };
}

async function castraDeploy(
  args: string[] = [],
  handler = wranglerHandler(),
  env: Record<string, string> = { CLOUDFLARE_API_TOKEN: FAKE_TOKEN },
) {
  const fx = fakeExec(handler);
  execCalls = fx.calls;
  const fetch = async (input: string, init?: RequestInit) => {
    const res = await cf.fetch(input, init);
    const last = cf.calls[cf.calls.length - 1]!;
    if (last.method === "POST") timeline.push(`api:POST ${last.path.replace(/^\/accounts\/acc1/, "")}`);
    if (last.path.endsWith("/secrets")) timeline.push("api:GET secrets");
    return res;
  };
  return run(["deploy", ...args], {
    cwd: dir,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    fetch,
    exec: fx.exec,
    env,
    openDatabase: async () => {
      throw new Error("deploy must not open the local database");
    },
  });
}

/** Commit a snapshot that matches `schemaRows(false)`. */
async function commitSnapshot() {
  const rows = schemaRows(false);
  const query: QueryFn = async (sql, params = []) => rows(sql, params);
  const code = await run(["generate"], {
    cwd: dir,
    log: () => {},
    error: () => {},
    openDatabase: async () => ({ query, close: async () => {} }),
  });
  expect(code).toBe(0);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "castra-deploy-"));
  await writeFile(join(dir, "wrangler.jsonc"), BLOG_CONFIG);
  cf = new FakeCloudflare();
  cf.d1Query = schemaRows(false);
  out = [];
  err = [];
  timeline = [];
  await commitSnapshot();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("castra deploy", () => {
  it("runs provision -> migrate --remote -> drift -> secret -> deploy in order and prints the URLs", async () => {
    expect(await castraDeploy()).toBe(0);
    expect(err).toEqual([]);
    expect(timeline).toEqual([
      "api:POST /d1/database",
      "api:POST /storage/kv/namespaces",
      "exec:d1 migrations",
      ...Array(cf.calls.filter((c) => c.path.endsWith("/query")).length).fill("api:POST /d1/database/d1-uuid-1/query"),
      "api:GET secrets",
      "exec:secret put",
      "exec:deploy --config",
    ]);

    const migrate = execCalls[0]!;
    expect(migrate.command).toBe("wrangler");
    expect(migrate.args).toEqual(["d1", "migrations", "apply", "castra-blog", "--remote", "--config", join(dir, "wrangler.jsonc")]);
    // R5-5: wrangler gets the token from deps.env, not process.env.
    expect(migrate.options.env).toEqual({ CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: "acc1" });
    for (const call of execCalls) expect(call.options.env).toMatchObject({ CLOUDFLARE_API_TOKEN: FAKE_TOKEN });

    const log = out.join("\n");
    expect(log).toContain("API:      https://castra-blog.testsub.workers.dev");
    expect(log).toContain("OpenAPI:  https://castra-blog.testsub.workers.dev/openapi.json");
    expect(log).toContain("MCP:      https://castra-blog.testsub.workers.dev/mcp");
  });

  it("generates BETTER_AUTH_SECRET once, passes it on stdin only, and never prints or writes it", async () => {
    expect(await castraDeploy()).toBe(0);
    const put = execCalls.find((c) => c.args[0] === "secret")!;
    expect(put.args).toEqual(["secret", "put", "BETTER_AUTH_SECRET", "--config", join(dir, "wrangler.jsonc")]);
    const secret = put.options.input!;
    // 32 random bytes, base64url.
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);

    for (const call of execCalls) {
      expect(call.args.join(" ")).not.toContain(secret);
      expect(JSON.stringify(call.options.env ?? {})).not.toContain(secret);
    }
    expect([...out, ...err].join("\n")).not.toContain(secret);
    expect(JSON.stringify(cf.calls)).not.toContain(secret);
    for (const file of await readdir(dir, { recursive: true })) {
      const path = join(dir, String(file));
      const text = await readFile(path, "utf8").catch(() => "");
      expect(text).not.toContain(secret);
    }
    // Only the secret step receives stdin.
    expect(execCalls.filter((c) => c.options.input !== undefined)).toHaveLength(1);
  });

  it("does not touch an existing secret on re-deploy, and re-provisioning creates nothing", async () => {
    expect(await castraDeploy()).toBe(0);
    timeline = [];
    expect(await castraDeploy()).toBe(0);
    expect(timeline.filter((t) => t.startsWith("api:POST") && !t.endsWith("/query"))).toEqual([]);
    expect(timeline).not.toContain("exec:secret put");
    expect(out.join("\n")).toContain("BETTER_AUTH_SECRET already set");
  });

  it("stops on schema drift before setting secrets or deploying", async () => {
    cf.d1Query = schemaRows(true);
    expect(await castraDeploy()).toBe(1);
    expect(timeline).toContain("exec:d1 migrations");
    expect(timeline).not.toContain("exec:secret put");
    expect(timeline.some((t) => t.startsWith("exec:deploy"))).toBe(false);
    const e = err.join("\n");
    expect(e).toContain("remote database");
    expect(e).toContain(`column "extra" is not in the snapshot`);
    expect(e).toContain("Deploy stopped");
  });

  it("stops when migrations fail", async () => {
    expect(await castraDeploy([], wranglerHandler({ migrate: 3 }))).toBe(3);
    expect(timeline.at(-1)).toBe("exec:d1 migrations");
  });

  it("stops before anything else when the token is missing", async () => {
    expect(await castraDeploy([], wranglerHandler(), {})).toBe(1);
    expect(err[0]).toContain("missing-token");
    expect(timeline).toEqual([]);
  });

  it("computes the workers.dev URL from the API when wrangler prints none", async () => {
    expect(await castraDeploy([], wranglerHandler({ deployStdout: "Uploaded castra-blog" }))).toBe(0);
    expect(out.join("\n")).toContain("API:      https://castra-blog.testsub.workers.dev");
  });

  it("reports a failed wrangler deploy", async () => {
    expect(await castraDeploy([], wranglerHandler({ deploy: 1 }))).toBe(1);
    expect(err.join("\n")).toContain("wrangler deploy exited with code 1");
  });
});

describe("parseDeployedUrl", () => {
  it("prefers the workers.dev URL", () => {
    expect(parseDeployedUrl(DEPLOY_OUTPUT)).toBe("https://castra-blog.testsub.workers.dev");
    expect(parseDeployedUrl("see https://dash.cloudflare.com/x\n  https://api.example.com (custom domain)")).toBe(
      "https://api.example.com",
    );
    expect(parseDeployedUrl("nothing here")).toBeUndefined();
  });
});

describe("castra migrate", () => {
  const migrate = async (args: string[]) => {
    const fx = fakeExec();
    const code = await run(["migrate", ...args], {
      cwd: dir,
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      exec: fx.exec,
      fetch: cf.fetch,
      env: { CLOUDFLARE_ACCOUNT_ID: "acc9" },
    });
    return { code, calls: fx.calls };
  };

  it("defaults to --local", async () => {
    const { code, calls } = await migrate([]);
    expect(code).toBe(0);
    expect(calls[0]!.args).toEqual(["d1", "migrations", "apply", "castra-blog", "--local", "--config", join(dir, "wrangler.jsonc")]);
    expect(calls[0]!.options.cwd).toBe(dir);
    expect(calls[0]!.options.env).toEqual({});
  });

  it("--remote passes the account id through the environment and makes no API call itself", async () => {
    const { code, calls } = await migrate(["--remote"]);
    expect(code).toBe(0);
    expect(calls[0]!.args).toContain("--remote");
    expect(calls[0]!.options.env).toEqual({ CLOUDFLARE_ACCOUNT_ID: "acc9" });
    expect(cf.calls).toEqual([]);
  });

  it("--remote hands wrangler the token from the injected env, not process.env (R5-5)", async () => {
    const fx = fakeExec();
    const code = await run(["migrate", "--remote"], {
      cwd: dir,
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      exec: fx.exec,
      fetch: cf.fetch,
      env: { CLOUDFLARE_API_TOKEN: " injected-token ", CLOUDFLARE_ACCOUNT_ID: "acc9" },
    });
    expect(code).toBe(0);
    expect(fx.calls[0]!.options.env).toEqual({ CLOUDFLARE_API_TOKEN: "injected-token", CLOUDFLARE_ACCOUNT_ID: "acc9" });
    // --local never needs (or receives) the token.
    const local = fakeExec();
    await run(["migrate"], { cwd: dir, log: () => {}, error: () => {}, exec: local.exec, fetch: cf.fetch, env: { CLOUDFLARE_API_TOKEN: "t" } });
    expect(local.calls[0]!.options.env).toEqual({});
  });

  it("rejects --local together with --remote", async () => {
    const { code, calls } = await migrate(["--local", "--remote"]);
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });
});
