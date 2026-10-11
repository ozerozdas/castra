/**
 * M5 review (create-castra). Each `it` demonstrates a confirmed defect and is expected to FAIL until fixed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffold } from "../src/scaffold.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "create-castra-review5-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** True when git would ignore `path` inside the scaffolded project (uses the generated .gitignore only). */
function ignored(project: string, path: string): boolean {
  const r = spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: project });
  return r.status === 0;
}

describe("R5-8 generated .gitignore misses the other env files wrangler loads", () => {
  it("ignores .dev.vars.<env> and .env.* (local secrets) but keeps .dev.vars.example tracked", async () => {
    const project = join(cwd, "app");
    await scaffold({ name: "app", targetDir: project, packageManager: "pnpm", castraVersion: "0.0.0" });
    execFileSync("git", ["init", "-q"], { cwd: project });

    expect(ignored(project, ".dev.vars")).toBe(true);
    expect(ignored(project, ".dev.vars.example")).toBe(false);
    // wrangler reads `.dev.vars.<env>` for `--env <env>` and `.env.local` / `.env.<env>` files; today all are committable.
    expect(ignored(project, ".dev.vars.staging")).toBe(true);
    expect(ignored(project, ".env.local")).toBe(true);
  });
});
