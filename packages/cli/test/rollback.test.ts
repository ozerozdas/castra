import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { run } from "../src/run.js";
import { rollback } from "../src/commands/rollback.js";
import { captureRollbackMetadata, rollbackMessage } from "../src/rollback-metadata.js";
import { FAKE_TOKEN, FakeCloudflare, forbidRealNetwork } from "./fake-cloudflare.js";
import type { RollbackDeps } from "../src/commands/rollback.js";
import type { OpenDatabaseFn } from "../src/local-d1.js";
forbidRealNetwork();
const current = "11111111-2222-3333-4444-555555555555";
const target = "22222222-2222-3333-4444-555555555555";
let dir: string, message: string, ddl: string, active: string, deploymentId: string;
let posts: RequestInit[], deps: RollbackDeps;
let targetMessage: string | undefined, currentMessage: string | undefined, rejectPost: boolean, split: boolean, skipActivation: boolean;
const config = { name: "blog", d1_databases: [{ binding: "DB", database_name: "blog", database_id: "db-1" }] };
const open: OpenDatabaseFn = async () => ({
  query: async (sql) => sql.startsWith("SELECT type, name") ? [{ type: "trigger", name: "check_posts", tbl_name: "posts", sql: ddl }] : [],
  close: async () => {},
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "castra-rollback-"));
  await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify(config));
  ddl = "CREATE TRIGGER check_posts BEFORE INSERT ON posts BEGIN SELECT 1; END";
  message = rollbackMessage(await captureRollbackMetadata(join(dir, "wrangler.jsonc"), open));
  targetMessage = currentMessage = message;
  active = current; deploymentId = "deployment-current"; posts = []; rejectPost = split = skipActivation = false;
  const cf = new FakeCloudflare();
  deps = { env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN }, log: () => {}, error: () => {}, openRemoteDatabase: () => open,
    fetch: async (url, init) => {
      if (!url.startsWith("https://api.cloudflare.com/client/v4/")) throw new Error("Unexpected network");
      let result: unknown;
      if (url.includes("/workers/scripts/blog/deployments")) {
        if (init?.method === "POST") {
          posts.push(init);
          if (rejectPost) return Response.json({ success: false, errors: [{ code: 10220, message: "Secret changed" }] }, { status: 400 });
          expect(new URL(url).searchParams.get("force")).toBe("false");
          if (!skipActivation) active = target; deploymentId = "deployment-rollback"; result = { id: deploymentId };
        } else result = { deployments: [
          { id: deploymentId, versions: split ? [{ version_id: current, percentage: 50 }, { version_id: target, percentage: 50 }] : [{ version_id: active, percentage: 100 }] },
          { id: "deployment-previous", versions: [{ version_id: target, percentage: 100 }] },
        ] };
      } else if (url.includes("/versions/")) result = { annotations: { "workers/message": url.endsWith(current) ? currentMessage : targetMessage } };
      else return cf.fetch(url, init);
      return Response.json({ success: true, result });
    },
  };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const execute = (extra: Partial<Parameters<typeof rollback>[0]> = {}) => rollback({ cwd: dir, config: "wrangler.jsonc", confirm: "blog", ...extra }, deps);
it("checks a dry run without changing traffic", async () => { expect(await execute({ dryRun: true })).toBe(0); expect(posts).toHaveLength(0); });
it("rolls back compatible versions and verifies traffic", async () => {
  expect(await execute()).toBe(0); expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0]!.body as string).versions).toEqual([{ version_id: target, percentage: 100 }]);
});
it("accepts an explicit compatible target", async () => { expect(await execute({ version: target })).toBe(0); });
it.each(["current", "target"])("refuses unmarked %s versions", async (which) => {
  if (which === "current") currentMessage = undefined; else targetMessage = undefined;
  await expect(execute()).rejects.toThrow(`${which} version ${which === "current" ? current : target} has no valid Castra rollback metadata`); expect(posts).toHaveLength(0);
});
it("detects trigger changes absent from policy snapshots", async () => {
  ddl += " changed"; await expect(execute()).rejects.toThrow("schema"); expect(posts).toHaveLength(0);
});
it("refuses config changes", async () => {
  await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({ ...config, compatibility_date: "2026-10-13" }));
  await expect(execute()).rejects.toThrow("configs"); expect(posts).toHaveLength(0);
});
it("ignores JSONC formatting and key order", async () => {
  await writeFile(join(dir, "wrangler.jsonc"), `// comment\n${JSON.stringify({ d1_databases: config.d1_databases, name: "blog" })}`);
  expect(await execute()).toBe(0);
});
it("refuses split traffic", async () => { split = true; await expect(execute()).rejects.toThrow("100%"); });
it("requires correct confirmation", async () => { await expect(execute({ confirm: "wrong" })).rejects.toThrow("confirmation"); expect(posts).toHaveLength(0); });
it.each(["deployment", "schema", "config"])("rechecks %s after prompting", async (change) => {
  deps.prompt = async () => {
    if (change === "deployment") deploymentId = "concurrent-deploy";
    if (change === "schema") ddl += " changed";
    if (change === "config") await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({ ...config, vars: { FLAG: "changed" } }));
    return "blog";
  };
  await expect(execute({ confirm: undefined })).rejects.toThrow(/changed|schema|configs/); expect(posts).toHaveLength(0);
});
it("does not force or retry a changed-secret rejection", async () => {
  rejectPost = true; await expect(execute()).rejects.toThrow("Secret changed"); expect(posts).toHaveLength(1);
});
it("refuses multiple D1 bindings", async () => {
  await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({ ...config, d1_databases: [...config.d1_databases, { binding: "OTHER", database_id: "db-2" }] }));
  await expect(execute()).rejects.toThrow("exactly one"); expect(posts).toHaveLength(0);
});

it("reports submitted but unverified activation without retrying", async () => {
  skipActivation = true;
  await expect(execute()).rejects.toThrow("Rollback submitted"); expect(posts).toHaveLength(1);
});
it("requires confirmation in a noninteractive session", async () => {
  await expect(execute({ confirm: undefined })).rejects.toThrow("confirmation"); expect(posts).toHaveLength(0);
});
it("CLI dry-run routes to the remote compatibility check", async () => {
  expect(await run(["rollback", "--dry-run"], { ...deps, cwd: dir })).toBe(0); expect(posts).toHaveLength(0);
});
it("rejects invalid version identifiers before connecting", async () => {
  await expect(execute({ version: "../invalid" })).rejects.toThrow("UUID"); expect(posts).toHaveLength(0);
});
