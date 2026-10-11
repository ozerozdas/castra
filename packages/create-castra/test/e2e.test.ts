import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/main.js";

/**
 * End-to-end: scaffold a project with --local-packages, install it, typecheck, run its tests and policy tests,
 * migrate + `generate --check` with the castra CLI, then `wrangler dev` on a free port and hit /health and
 * /api/notes. Needs network access for third-party packages (or a warm pnpm store) and a prior `pnpm -r build`.
 *
 * Opt-in, not part of `pnpm -r test`: `pnpm --filter create-castra test:e2e`.
 */
const E2E = process.env.CASTRA_E2E === "1";
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const NO_TELEMETRY = { WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" };

interface Result {
  code: number;
  output: string;
}

function run(command: string, args: string[], cwd: string): Promise<Result> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...NO_TELEMETRY, CI: "1" } });
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
  return r.output;
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePromise(port));
    });
  });
}

let root: string;
let app: string;

describe.skipIf(!E2E)("create-castra e2e", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "create-castra-e2e-"));
    app = join(root, "e2e-app");
    const log: string[] = [];
    const code = await main(["e2e-app", "--no-install", "--local-packages", REPO], {
      cwd: root,
      log: (l) => log.push(l),
      error: (l) => log.push(l),
      env: {},
    });
    expect(code, log.join("\n")).toBe(0);
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("installs", async () => {
    await expectOk("pnpm", ["install", "--prefer-offline"], app);
  }, 600_000);

  it("typechecks", async () => {
    await expectOk("pnpm", ["run", "typecheck"], app);
  }, 120_000);

  it("passes its own tests and `castra test policies`", async () => {
    expect(await expectOk("pnpm", ["test"], app)).toMatch(/Tests\s+\d+ passed/);
    expect(await expectOk("pnpm", ["run", "test:policies"], app)).toMatch(/Test Files\s+1 passed/);
  }, 300_000);

  it("migrates the local D1 and its committed snapshot has no drift", async () => {
    await expectOk("pnpm", ["run", "db:migrate:local"], app);
    expect(await expectOk("pnpm", ["exec", "castra", "generate", "--check"], app)).toContain("up to date");
  }, 120_000);

  it("`wrangler dev` serves /health and /api/notes", async () => {
    await writeFile(
      join(app, ".dev.vars"),
      `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}\nBETTER_AUTH_URL=http://127.0.0.1\n`,
    );
    const [port, inspector] = [await freePort(), await freePort()];
    // Own process group, so stopping it also stops the workerd child; only this group is signalled.
    const child = spawn(
      join(app, "node_modules", ".bin", "wrangler"),
      ["dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--show-interactive-dev-session=false"],
      { cwd: app, env: { ...process.env, ...NO_TELEMETRY }, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout!.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr!.on("data", (c: Buffer) => (output += c.toString()));
    const stop = () => {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        // already exited
      }
    };
    try {
      const base = `http://127.0.0.1:${port}`;
      let health: Response | undefined;
      for (let i = 0; i < 120 && !health; i++) {
        if (child.exitCode !== null) break;
        health = await fetch(`${base}/health`).catch(() => undefined);
        if (!health) await new Promise((r) => setTimeout(r, 500));
      }
      expect(health?.status, output).toBe(200);
      expect(await health!.json()).toEqual({ ok: true });

      const notes = await fetch(`${base}/api/notes`);
      expect(notes.status, output).toBe(200);
      expect(((await notes.json()) as { data: unknown[] }).data).toEqual([]);
    } finally {
      const exited = new Promise((r) => child.once("exit", r));
      stop();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 180_000);
});
