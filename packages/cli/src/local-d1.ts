import { dirname, join, resolve } from "node:path";
import type { QueryFn } from "@castra-kit/core";

/** An open handle on a database; `close` must always be called. */
export interface OpenDatabase {
  query: QueryFn;
  close: () => Promise<void>;
}

/** Opens the database behind a binding. Injected into commands so tests can avoid wrangler. */
export type OpenDatabaseFn = (configPath: string, binding: string) => Promise<OpenDatabase>;

interface D1Like {
  prepare(sql: string): {
    bind(...params: unknown[]): { all(): Promise<{ results: Record<string, unknown>[] }> };
  };
}

/**
 * Open the LOCAL D1 database (the miniflare sqlite under `.wrangler/state/v3` next to the config) through
 * wrangler's `getPlatformProxy`. See ADR 0011 for why this is used instead of shelling out to
 * `wrangler d1 execute`.
 */
export const openLocalD1: OpenDatabaseFn = async (configPath, binding) => {
  const absolute = resolve(configPath);
  let getPlatformProxy: typeof import("wrangler").getPlatformProxy;
  try {
    ({ getPlatformProxy } = await import("wrangler"));
  } catch {
    throw new Error("Cannot load wrangler. Install it in your project (`pnpm add -D wrangler`).");
  }

  const proxy = await getPlatformProxy<Record<string, unknown>>({
    configPath: absolute,
    // Same location `wrangler d1 migrations apply --local` writes to.
    persist: { path: join(dirname(absolute), ".wrangler", "state", "v3") },
    remoteBindings: false,
  });

  const db = proxy.env[binding] as D1Like | undefined;
  if (!db || typeof db.prepare !== "function") {
    await proxy.dispose();
    throw new Error(`Binding "${binding}" is not a D1 database in ${configPath}.`);
  }

  return {
    query: async (sql, params = []) => (await db.prepare(sql).bind(...params).all()).results,
    close: () => proxy.dispose(),
  };
};
