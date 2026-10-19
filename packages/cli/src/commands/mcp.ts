import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { ApiError, type CastraConfig, type SchemaSnapshot } from "@castra-kit/core";
import type { MigrationCallbacks } from "@castra-kit/mcp";
import { CliError, readD1Target } from "../wrangler-config.js";
import type { ExecFn } from "../exec.js";
import { generate } from "./generate.js";
import { migrate, migrateCreate, migrateStatus, type MigrateStatus } from "./migrate.js";
import { doctor, type DoctorDeps } from "./doctor.js";

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
export async function mcp(options: McpOptions, deps: DoctorDeps & { exec: ExecFn }): Promise<number> {
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

    /** Reads wrangler.jsonc and picks the D1 binding (migration tools are local-only). */
    const resolveTarget: MigrationCallbacks["resolveTarget"] = async () => {
      const targetPath = resolve(options.cwd, options.wrangler);
      let text: string;
      try {
        text = await readFile(targetPath, "utf8");
      } catch {
        throw new ApiError(400, "wrangler_config_not_found", `Cannot read wrangler config at ${targetPath}.`);
      }
      let target: ReturnType<typeof readD1Target>;
      try {
        target = readD1Target(text, options.binding);
      } catch (e) {
        if (
          e instanceof CliError &&
          (e.message.startsWith("No d1_databases entry found") ||
            e.message.startsWith("No D1 binding named") ||
            e.message.startsWith("The wrangler config declares several D1 databases") ||
            e.message.startsWith("Cannot find a D1 binding"))
        ) {
          throw new ApiError(400, "no_d1_binding", e.message);
        }
        throw e;
      }
      if (target.migrationsPattern) {
        throw new ApiError(
          400,
          "migrations_pattern_unsupported",
          `D1 binding "${target.binding}" uses migrations_pattern; castra migrate create/status only support flat ` +
            `<migrations_dir>/*.sql. Use \`wrangler d1 migrations create/list\` instead.`,
        );
      }
      return {
        dir: resolve(dirname(targetPath), target.migrationsDir),
        binding: target.binding,
        targetName: target.databaseName ?? target.binding,
      };
    };

    const migrations: MigrationCallbacks = {
      resolveTarget,
      createMigration: async (name) => {
        const target = await resolveTarget();
        let path: string;
        try {
          path = await migrateCreate({ cwd: options.cwd, config: options.wrangler, binding: target.binding, name }, { log: deps.log });
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("Give the migration a name")) {
            throw new ApiError(400, "invalid_name", e.message);
          }
          throw e;
        }
        const body = await readFile(path, "utf8");
        return { file: basename(path), path, body };
      },
      readStatus: async () => {
        const target = await resolveTarget();
        return migrateStatus(
          { cwd: options.cwd, config: options.wrangler, binding: target.binding, target: "local" },
          { openDatabase: deps.openDatabase, log: deps.log },
        );
      },
      driftCheck: async () => {
        const target = await resolveTarget();
        const drift: string[] = [];
        const code = await generate(
          { cwd: options.cwd, config: options.wrangler, out: options.out, check: true, binding: target.binding },
          { openDatabase: deps.openDatabase, log: () => {}, error: (line) => drift.push(line) },
        );
        return { ok: code === 0, drift };
      },
      applyMigrations: async () => {
        const target = await resolveTarget();
        const silentExec: ExecFn = (cmd, args, opts) => deps.exec(cmd, args, { ...opts, echo: false });
        const code = await migrate(
          { cwd: options.cwd, config: options.wrangler, target: "local", binding: target.binding, accountId: undefined },
          { exec: silentExec, env: deps.env, log: deps.log, error: deps.error },
        );
        return { code };
      },
    };

    const stdin = options.stdin ?? process.stdin;
    const closed = new Promise<void>((done) => {
      stdin.once("end", done);
      stdin.once("close", done);
    });
    const server = await serveStdio({
      config,
      snapshot,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      d1: d1 as any,
      stdin,
      stdout: options.stdout ?? process.stdout,
      // deploy_status is `castra doctor` (ADR 0079); its table output is discarded, the rows are returned.
      deployStatus: async ({ remote }) => {
        const r = await doctor(
          { cwd: options.cwd, config: options.wrangler, out: options.out, remote },
          { ...deps, log: () => {}, error: () => {} },
        );
        return { ok: r.code === 0, checks: r.checks, drift: r.drift };
      },
      // propose_policy (ADR 0082) diffs the file as it is now; the running config stays the one loaded above.
      configSource: async () => ({ path: relative(options.cwd, configPath), source: await readFile(configPath, "utf8") }),
      migrations,
    });
    process.stderr.write(`castra mcp: serving ${Object.keys(config.tables).length} configured table(s) from local D1 "${binding}" over stdio\n`);
    await closed;
    await server.close();
    return 0;
  } finally {
    await proxy.dispose();
  }
}
