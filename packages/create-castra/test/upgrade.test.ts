import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localPackageSpecs, scaffold } from "../src/scaffold.js";

/**
 * Upgrade test (issue #19, ADR 0083): scaffold the template of the release the newest upgrade note starts from, apply
 * that note exactly as written (its package commands, scripts block and diffs), point the Castra packages at this
 * checkout, then install, typecheck, test, migrate and check drift. Needs the release tags (`fetch-depth: 0`),
 * network access for third-party packages and a prior `pnpm -r build`.
 *
 * Opt-in, not part of `pnpm -r test`: `pnpm --filter @castra-kit/create test:upgrade`.
 */
const E2E = process.env.CASTRA_E2E === "1";
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const NOTES = join(REPO, "docs/upgrading");
const ENV = { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", CI: "1" };

function run(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: ENV });
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr.on("data", (c: Buffer) => (output += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, output }));
  });
}

async function expectOk(command: string, args: string[], cwd: string): Promise<string> {
  const r = await run(command, args, cwd);
  expect(r.code, `${command} ${args.join(" ")}\n${r.output}`).toBe(0);
  // CI forces colour; strip it so the summary lines match.
  return stripVTControlCharacters(r.output);
}

/** Fenced blocks of one language (``` or ````). */
function blocks(note: string, lang: string): string[] {
  return [...note.matchAll(new RegExp(`^(\`{3,4})${lang}\\n([\\s\\S]*?)\\n\\1$`, "gm"))].map((m) => m[2]!);
}

/** Applies the note's `pnpm add` / `pnpm remove` lines and scripts block to package.json, as a user would. */
function applyPackageChanges(pkgText: string, note: string, castra: Record<string, string>): string {
  const pkg = JSON.parse(pkgText) as Record<string, Record<string, string>>;
  const section = blocks(note, "bash")[0]!;
  for (const line of section.split("\n")) {
    const [, verb, ...rest] = line.trim().split(/\s+/);
    const dev = rest[0] === "-D";
    const names = dev ? rest.slice(1) : rest;
    for (const spec of names) {
      if (verb === "remove") {
        delete pkg.dependencies?.[spec];
        delete pkg.devDependencies?.[spec];
        continue;
      }
      const at = spec.lastIndexOf("@");
      const name = spec.slice(0, at);
      const target = (pkg[dev ? "devDependencies" : "dependencies"] ??= {});
      target[name] = castra[name] ?? spec.slice(at + 1);
    }
  }
  const scripts = blocks(note, "json")[0];
  if (scripts) pkg.scripts = { ...pkg.scripts, ...(JSON.parse(scripts) as Record<string, string>) };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

let root: string;
let app: string;

describe.skipIf(!E2E)("upgrade from the previous release", () => {
  beforeAll(async () => {
    const latest = (await readdir(NOTES))
      .filter((f) => /^\d+\.\d+\.\d+\.md$/.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1)!;
    const note = await readFile(join(NOTES, latest), "utf8");
    const from = /<!-- upgrade-from: (v[\d.]+) -->/.exec(note)![1]!;

    root = await mkdtemp(join(tmpdir(), "castra-upgrade-"));
    const old = join(root, "old");
    await mkdir(old);
    const archive = execFileSync("git", ["archive", "--format=tar", from, "packages/create-castra/template"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", old], { input: archive });
    app = join(root, "castra-app");
    // The template's own name, so README and wrangler.jsonc match the diff context.
    await scaffold({ name: "castra-app", targetDir: app, packageManager: "pnpm", castraVersion: from.slice(1), templateDir: join(old, "packages/create-castra/template") });

    const { specs } = await localPackageSpecs(REPO, "pnpm");
    await writeFile(join(app, "package.json"), applyPackageChanges(await readFile(join(app, "package.json"), "utf8"), note, specs));
    await writeFile(join(root, "upgrade.patch"), blocks(note, "diff").map((d) => `${d}\n`).join(""));
    await expectOk("git", ["apply", "--verbose", join(root, "upgrade.patch")], app);
  }, 60_000);
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("installs, typechecks and passes its tests", async () => {
    await expectOk("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], app);
    await expectOk("pnpm", ["run", "typecheck"], app);
    expect(await expectOk("pnpm", ["test"], app)).toMatch(/Tests\s+\d+ passed/);
    expect(await expectOk("pnpm", ["run", "test:policies"], app)).toMatch(/Test Files\s+1 passed/);
  }, 900_000);

  it("migrates and its snapshot has no drift", async () => {
    await expectOk("pnpm", ["run", "db:migrate:local"], app);
    expect(await expectOk("pnpm", ["exec", "castra", "generate", "--check"], app)).toContain("up to date");
  }, 120_000);
});
