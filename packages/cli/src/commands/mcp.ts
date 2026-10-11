import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { CastraConfig, SchemaSnapshot } from "castra";
import { CliError, readD1Target } from "../wrangler-config.js";

/** Options of {@link mcp}. */
export interface McpOptions {
  cwd: string;
  /** Castra config module (default `castra.config.ts`). */
  config: string;
  /** Wrangler config (default `wrangler.jsonc`). */
  wrangler: string;
  binding?: string;
  /** Directory holding the committed `schema.json` (default `castra`). */
  out: string;
  stdin?: Readable;
  stdout?: Writable;
}

/**
 * Imports a Castra config module and returns its default export. `.ts` configs rely on Node's built-in type
 * stripping (Node >= 22.18); older Node needs a `.js`/`.mjs` config (ADR 0065).
 */
export async function loadCastraConfig(path: string): Promise<CastraConfig> {
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" && String((e as Error).message).includes(path)) throw new CliError(`Cannot find Castra config at ${path}.`);
    if (code === "ERR_UNKNOWN_FILE_EXTENSION") {
      throw new CliError(`Cannot load ${path}: this Node version cannot import TypeScript. Use Node >= 22.18 or a .js/.mjs config.`);
    }
    throw e;
  }
  const config = mod.default;
  if (!config || typeof config !== "object" || !("tables" in config)) {
    throw new CliError(`${path} must default-export defineConfig({ ... }).`);
  }
  return config as CastraConfig;
}

/**
 * `castra mcp`: serves the MCP tools over stdio against the LOCAL D1 database (wrangler's `getPlatformProxy`).
 * A local developer tool: `as` may impersonate ANY user or role, there are no tokens and no audit log.
 * Resolves when stdin closes.
 */
export async function mcp(options: McpOptions): Promise<number> {
  const configPath = resolve(options.cwd, options.config);
  const wranglerPath = resolve(options.cwd, options.wrangler);
  const snapshotPath = resolve(options.cwd, options.out, "schema.json");

  let wranglerText: string;
  try {
    wranglerText = await readFile(wranglerPath, "utf8");
  } catch {
    throw new CliError(`Cannot read wrangler config at ${wranglerPath}.`);
  }
  const { binding } = readD1Target(wranglerText, options.binding);

  let snapshot: SchemaSnapshot;
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as SchemaSnapshot;
  } catch {
    throw new CliError(`Cannot read ${snapshotPath}; run \`castra generate\` first.`);
  }
  const config = await loadCastraConfig(configPath);

  const { getPlatformProxy } = await import("wrangler");
  const { serveStdio } = await import("@castra-kit/mcp/stdio");
  const proxy = await getPlatformProxy<Record<string, unknown>>({
    configPath: wranglerPath,
    persist: { path: join(dirname(wranglerPath), ".wrangler", "state", "v3") },
    remoteBindings: false,
  });
  try {
    const d1 = proxy.env[binding] as { prepare?: unknown } | undefined;
    if (!d1 || typeof d1.prepare !== "function") throw new CliError(`Binding "${binding}" is not a D1 database in ${wranglerPath}.`);
    const stdin = options.stdin ?? process.stdin;
    const closed = new Promise<void>((done) => {
      stdin.once("end", done);
      stdin.once("close", done);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = await serveStdio({ config, snapshot, d1: d1 as any, stdin, stdout: options.stdout ?? process.stdout });
    process.stderr.write(`castra mcp: serving ${Object.keys(config.tables).length} configured table(s) from local D1 "${binding}" over stdio\n`);
    await closed;
    await server.close();
    return 0;
  } finally {
    await proxy.dispose();
  }
}
