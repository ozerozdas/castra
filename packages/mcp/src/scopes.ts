/**
 * MCP token scopes (ARCHITECTURE §5, ADR 0061). No scope grants admin rights or writes.
 */

/** Every scope a remote MCP token can carry. */
export const MCP_SCOPES = ["schema:read", "access:check", "data:read", "data:read:any_user"] as const;

/** One MCP token scope. */
export type McpScope = (typeof MCP_SCOPES)[number];

/** The four read-only tools shared by the stdio and the remote server. */
export const TOOL_NAMES = ["describe_schema", "check_access", "explain_query", "query_data"] as const;

/** Name of a Castra MCP tool. */
export type ToolName = (typeof TOOL_NAMES)[number];

/** The scope a remote token needs to call each tool (as itself). */
export const TOOL_SCOPES: Readonly<Record<ToolName, McpScope>> = Object.freeze({
  describe_schema: "schema:read",
  check_access: "access:check",
  explain_query: "access:check",
  query_data: "data:read",
});

/** Extra scope needed when `as` names an identity other than the token's own user (ADR 0061). */
export const ANY_USER_SCOPE: McpScope = "data:read:any_user";

/** True for a known scope string. */
export function isMcpScope(value: string): value is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(value);
}

/**
 * Parses scopes given as a space-separated string (as stored) or a list. Throws on an unknown or
 * empty scope list. Returns them de-duplicated in canonical order.
 */
export function parseScopes(input: string | readonly string[]): McpScope[] {
  const parts = typeof input === "string" ? input.split(/\s+/) : [...input];
  const wanted = new Set<string>();
  for (const raw of parts) {
    const s = raw.trim();
    if (s === "") continue;
    if (!isMcpScope(s)) throw new Error(`unknown MCP scope "${s}" (known: ${MCP_SCOPES.join(", ")})`);
    wanted.add(s);
  }
  if (wanted.size === 0) throw new Error(`at least one MCP scope is required (known: ${MCP_SCOPES.join(", ")})`);
  return MCP_SCOPES.filter((s) => wanted.has(s));
}

/**
 * Reads scopes stored on a token row. Unknown entries make the whole row invalid (`null`), so a
 * tampered or future-format row never grants anything.
 */
export function readStoredScopes(stored: string): McpScope[] | null {
  try {
    return parseScopes(stored);
  } catch {
    return null;
  }
}
