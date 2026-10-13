import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { introspect } from "@castra-kit/core";
import type { OpenDatabaseFn } from "./local-d1.js";
import { CliError, isPlaceholderId, readWranglerConfig } from "./wrangler-config.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
/** Versioned compatibility fingerprints stored in the Worker version message. */
export interface RollbackMetadata {
  schema: string;
  config: string;
}
/** Encode fingerprints without including config values or row data. */
export function rollbackMessage(metadata: RollbackMetadata): string {
  return `castra:rollback:v1:${metadata.schema}:${metadata.config}`;
}
/** Refuse older/unmarked versions rather than assuming compatibility. */
export function parseRollbackMessage(message: string | undefined): RollbackMetadata {
  const match = /^castra:rollback:v1:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(message ?? "");
  if (!match) throw new CliError("Rollback refused: version has no valid Castra rollback metadata.");
  return { schema: match[1]!, config: match[2]! };
}
/** Fingerprint parsed JSONC config plus live introspection/DDL, including indexes and triggers. */
export async function captureRollbackMetadata(configPath: string, open: OpenDatabaseFn): Promise<RollbackMetadata> {
  const text = await readFile(configPath, "utf8");
  const config = readWranglerConfig(text);
  const binding = config.d1[0];
  if (config.d1.length !== 1 || !binding || isPlaceholderId(binding.databaseId)) {
    throw new CliError("Rollback requires exactly one provisioned D1 binding.");
  }
  const db = await open(configPath, binding.binding);
  try {
    const snapshot = await introspect(db.query, { generatedAt: "rollback-v1" });
    const ddl = await db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name", []);
    return { schema: hash({ snapshot, ddl }), config: hash(parse(text)) };
  } finally {
    await db.close();
  }
}
