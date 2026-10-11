import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, migrate, openLocalD1, spawnExec, type ExecFn } from "@castra/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scaffold, TEMPLATE_NAME } from "../src/scaffold.js";

/**
 * The template ships a committed castra/schema.json and castra/db.d.ts. They must be exactly what
 * `castra migrate --local && castra generate` produces for the template's migrations, otherwise a fresh project
 * starts with a stale snapshot (wrong routes/OpenAPI, and `castra deploy` refuses to ship). This runs the real
 * commands: wrangler applies the migrations to a local D1 in a temp copy, then `generate --check` compares.
 */

// The wrangler binary installed for this package (spawnExec only adds the project's own node_modules/.bin).
const BIN = fileURLToPath(new URL("../node_modules/.bin", import.meta.url));
const exec: ExecFn = (command, args, options) =>
  spawnExec(command, args, {
    ...options,
    echo: false,
    env: { ...options.env, PATH: [BIN, process.env.PATH ?? ""].join(delimiter), WRANGLER_SEND_METRICS: "false" },
  });

let dir: string;
const out: string[] = [];
const err: string[] = [];
const deps = { exec, openDatabase: openLocalD1, log: (l: string) => out.push(l), error: (l: string) => err.push(l) };

beforeAll(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "create-castra-drift-")), TEMPLATE_NAME);
  // Same name as the template, so the copy is byte-identical apart from the package.json rewrite.
  await scaffold({ name: TEMPLATE_NAME, targetDir: dir, packageManager: "pnpm", castraVersion: "0.0.0" });
});
afterAll(async () => {
  await rm(join(dir, ".."), { recursive: true, force: true });
});

describe("template snapshot", () => {
  it("castra/schema.json and castra/db.d.ts match what castra generate produces from the migrations", async () => {
    const migrated = await migrate({ cwd: dir, config: "wrangler.jsonc", target: "local" }, deps);
    expect(migrated, err.join("\n")).toBe(0);
    const code = await generate({ cwd: dir, config: "wrangler.jsonc", out: "castra", check: true }, deps);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Schema snapshot is up to date");
  }, 120_000);
});
