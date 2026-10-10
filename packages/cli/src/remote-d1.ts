import { readFile } from "node:fs/promises";
import type { CloudflareApi } from "./cloudflare/api.js";
import type { OpenDatabaseFn } from "./local-d1.js";
import { CliError, isPlaceholderId, readWranglerConfig } from "./wrangler-config.js";

/**
 * An {@link OpenDatabaseFn} for the REMOTE D1 database behind a binding, via the D1 HTTP query endpoint
 * (`POST /accounts/{id}/d1/database/{uuid}/query`). Used by `castra deploy` for the drift check after the remote
 * migrations ran. Read-only in practice: `introspect` only issues `SELECT` and `PRAGMA` statements.
 */
export function remoteD1Opener(api: CloudflareApi, accountId: string): OpenDatabaseFn {
  return async (configPath, binding) => {
    const config = readWranglerConfig(await readFile(configPath, "utf8"));
    const entry = config.d1.find((d) => d.binding === binding);
    if (!entry || isPlaceholderId(entry.databaseId)) {
      throw new CliError(`D1 binding "${binding}" has no provisioned database_id; run \`castra provision\`.`);
    }
    const databaseId = entry.databaseId!;
    return {
      query: (sql, params) => api.queryD1(accountId, databaseId, sql, params),
      close: async () => {},
    };
  };
}
