import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import type { ToolAccess } from "./identity.js";
import type { ToolName } from "./scopes.js";
import { castraTools, type CastraToolsOptions, type ToolOutcome } from "./tools.js";

/** Package version reported in the MCP `initialize` result. */
export const SERVER_VERSION = "0.0.0";

/** A finished tool call, reported to {@link CastraMcpServerOptions.onToolResult} (the audit log uses it). */
export interface ToolCallRecord {
  requestId: string | number;
  tool: ToolName;
  outcome: ToolOutcome["outcome"];
  status: number;
}

/** Options of {@link createCastraMcpServer}. */
export interface CastraMcpServerOptions extends CastraToolsOptions {
  /** Who may call what, as whom: `localAccess` (stdio) or `remoteAccess` (token scopes). */
  access: ToolAccess;
  /** Called after every tool call, success or failure. */
  onToolResult?: (record: ToolCallRecord) => void;
  /** Server name in `initialize`. Default `castra`. */
  name?: string;
}

/**
 * The SDK validates JSON Schema only for elicitation, which Castra never uses. This validator rejects
 * everything instead of the default Ajv one, which compiles code at runtime (`new Function`, refused
 * by Workers).
 */
const noJsonSchemaValidation: jsonSchemaValidator = {
  getValidator: () => () => ({ valid: false, data: undefined, errorMessage: "JSON Schema validation is not supported by this server" }),
};

function toResult(o: ToolOutcome): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(o.data) }],
    structuredContent: o.data,
    ...(o.outcome === "ok" ? {} : { isError: true }),
  };
}

/**
 * Builds an `McpServer` with the four shared read-only tools (`describe_schema`, `check_access`,
 * `explain_query`, `query_data`). The stdio and the remote transport both use this function, so the
 * tool set and behaviour are identical; only `access` differs.
 */
export function createCastraMcpServer(options: CastraMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: options.name ?? "castra", version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      jsonSchemaValidator: noJsonSchemaValidation,
      instructions:
        "Castra backend verification tools. All tools are read-only and evaluate the same policy engine as the REST API. Start with describe_schema.",
    },
  );
  for (const tool of castraTools(options)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args: Record<string, unknown>, extra) => {
        const outcome = await tool.run(args, options.access);
        options.onToolResult?.({ requestId: extra.requestId, tool: tool.name, outcome: outcome.outcome, status: outcome.status });
        return toResult(outcome);
      },
    );
  }
  return server;
}
