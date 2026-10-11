/**
 * `@castra-kit/mcp`: the read-only MCP tools (`describe_schema`, `check_access`, `explain_query`,
 * `query_data`), the remote `/mcp` route with scoped tokens and audit log, and token management.
 * The stdio server lives in `@castra-kit/mcp/stdio` (Node only). See docs/ARCHITECTURE.md §5, ADRs 0060-0064.
 * @packageDocumentation
 */

/** Package identifier. */
export const name = "@castra-kit/mcp";

export { ANY_USER_SCOPE, isMcpScope, MCP_SCOPES, parseScopes, TOOL_NAMES, TOOL_SCOPES } from "./scopes.js";
export type { McpScope, ToolName } from "./scopes.js";
export {
  createMcpToken,
  insertMcpTokenQuery,
  MCP_TOKEN_PREFIX,
  mintMcpToken,
  parseMcpToken,
  revokeMcpToken,
  revokeMcpTokenQuery,
  verifyMcpToken,
} from "./tokens.js";
export type { CreatedMcpToken, CreateMcpTokenInput, McpTokenFailure, McpTokenVerification, VerifiedMcpToken } from "./tokens.js";
export { anonymous, asSchema, contextFor, describeIdentity, localAccess, remoteAccess, ToolDenied } from "./identity.js";
export type { AsInput, TokenIdentity, ToolAccess } from "./identity.js";
export { castraTools, parseRestPath } from "./tools.js";
export type { CastraToolsOptions, ToolDefinition, ToolOutcome } from "./tools.js";
export { createCastraMcpServer, SERVER_VERSION } from "./server.js";
export type { CastraMcpServerOptions, ToolCallRecord } from "./server.js";
export { createMcpRoute, handleMcpRequest, MCP_MAX_BODY_BYTES, MCP_MAX_MESSAGES } from "./remote.js";
export type { McpHandlerOptions, McpRouteOptions } from "./remote.js";
export { auditArguments, writeAudit } from "./audit.js";
export type { AuditEntry } from "./audit.js";
export { AUDIT_ARGUMENTS_MAX, compileOnly, mcpDb } from "./db.js";
export type { AuditTable, D1Like, McpDatabase, McpDb, McpDbInput, McpTokensTable } from "./db.js";
