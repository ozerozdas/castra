/**
 * `generate_migration` / `apply_migration` (ADR 0086): local-only MCP tools that delegate to the
 * `castra migrate` workflow. They never execute SQL themselves; wrangler stays the runner.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toProblem } from "@castra-kit/core";
import { z } from "zod";

/** Callbacks the CLI injects; the MCP layer treats them as opaque and never imports `@castra-kit/cli`. */
export interface MigrationCallbacks {
  /** Reads the wrangler config, picks the migrations dir, returns `dir`, `binding`, `targetName`. */
  resolveTarget(): Promise<{ dir: string; binding: string; targetName: string }>;
  /** Returns the next migration file name, absolute path, and file body. */
  createMigration(name: string): Promise<{ file: string; path: string; body: string }>;
  /** Returns the same shape as CLI `migrateStatus`. */
  readStatus(): Promise<{ applied: string[]; pending: string[]; unknown: string[] }>;
  /** Runs a drift check (commit vs. local D1). */
  driftCheck(): Promise<{ ok: boolean; drift: string[] }>;
  /** Returns the wrangler exit code; echoes to stderr only. */
  applyMigrations(): Promise<{ code: number }>;
}

interface Result {
  outcome: "ok" | "error";
  status: number;
  data: Record<string, unknown>;
}

function toResult(o: Result): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(o.data) }],
    structuredContent: o.data,
    ...(o.outcome === "ok" ? {} : { isError: true }),
  };
}

/**
 * Registers `generate_migration` and `apply_migration` on `server` when the host provides a
 * `migrations` callback. The tools are local-only and never write `_castra_audit` rows.
 */
export function registerMigrations(server: McpServer, callbacks: MigrationCallbacks): void {
  server.registerTool(
    "generate_migration",
    {
      title: "Generate a migration file",
      description:
        "Creates an empty migration file under <migrations_dir>/NNNN_<slug>.sql with a header comment for the SQL body and the rollback comment. Returns the path and the file's current contents. " +
        "Local only. NEVER applied. The agent fills the body by hand.",
      inputSchema: { name: z.string().min(1).max(256).describe("Human-readable name, e.g. 'add notes title'.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args: { name: string }) => {
      try {
        const file = await callbacks.createMigration(args.name);
        return toResult({
          outcome: "ok",
          status: 200,
          data: {
            written: true,
            path: file.path,
            file: file.file,
            preview: file.body,
            next: "Open the file, paste the SQL between the header and the rollback comment, then call apply_migration.",
          },
        });
      } catch (e) {
        const p = toProblem(e);
        return toResult({ outcome: "error", status: p.status, data: { ...p } });
      }
    },
  );

  server.registerTool(
    "apply_migration",
    {
      title: "Apply pending migrations to local D1",
      description:
        "Lists pending migrations. With approve: false (default) returns the same list without applying. With approve: true, after a successful drift check, runs `wrangler d1 migrations apply` and reports the exit code. " +
        "Local only. The MCP stdio stream never sees wrangler output.",
      inputSchema: {
        approve: z.boolean().optional().describe("Required true to actually apply. false or absent returns a dry-run status."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args: { approve?: boolean }) => {
      try {
        const status = await callbacks.readStatus();
        if (args.approve !== true) {
          return toResult({
            outcome: "ok",
            status: 200,
            data: {
              approved: false,
              applied: status.applied,
              pending: status.pending,
              unknown: status.unknown,
              hint: "Call again with { approve: true } to apply.",
            },
          });
        }
        const drift = await callbacks.driftCheck();
        if (!drift.ok) {
          return toResult({ outcome: "error", status: 409, data: { code: "schema_drift", detail: drift.drift } });
        }
        const result = await callbacks.applyMigrations();
        if (result.code !== 0) {
          return toResult({ outcome: "error", status: 500, data: { code: "wrangler_failed", exitCode: result.code } });
        }
        return toResult({
          outcome: "ok",
          status: 200,
          data: {
            approved: true,
            applied: status.pending,
            next: "Run `castra generate` to refresh castra/ and commit the result.",
          },
        });
      } catch (e) {
        const p = toProblem(e);
        return toResult({ outcome: "error", status: p.status, data: { ...p } });
      }
    },
  );
}
