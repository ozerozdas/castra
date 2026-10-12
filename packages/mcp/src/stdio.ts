/**
 * `@castra-kit/mcp/stdio`: the local MCP server over stdio (Node only). Used by `castra mcp`.
 * @packageDocumentation
 */
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CastraConfig, D1DatabaseLike, PolicyEngine, SchemaSnapshot } from "@castra-kit/core";
import { mcpDb, type D1Like } from "./db.js";
import { localAccess } from "./identity.js";
import { createCastraMcpServer, type DeployStatusFn } from "./server.js";

/** Options of {@link serveStdio}. */
export interface ServeStdioOptions {
  config: CastraConfig;
  snapshot: SchemaSnapshot;
  /** The local D1 binding (e.g. from wrangler's `getPlatformProxy`). */
  d1: D1Like;
  engine?: PolicyEngine;
  basePath?: string;
  /** Default `process.stdin` / `process.stdout`. */
  stdin?: Readable;
  stdout?: Writable;
  /** Registers `deploy_status` (ADR 0079). */
  deployStatus?: DeployStatusFn;
}

/**
 * Serves the shared tools over stdio with {@link localAccess}: a developer tool that may evaluate as
 * ANY identity (`as`), with no tokens and no audit log. Never expose it over a network.
 * Resolves once connected; the returned server closes on `close()` or when stdin ends.
 */
export async function serveStdio(options: ServeStdioOptions): Promise<McpServer> {
  const db = mcpDb(options.d1);
  const server = createCastraMcpServer({
    config: options.config,
    snapshot: options.snapshot,
    engine: options.engine,
    db,
    d1: options.d1 as unknown as D1DatabaseLike,
    basePath: options.basePath,
    access: localAccess(db, options.config),
    name: "castra-local",
    deployStatus: options.deployStatus,
  });
  await server.connect(new StdioServerTransport(options.stdin, options.stdout));
  return server;
}
