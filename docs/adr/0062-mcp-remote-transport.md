# 0062. Remote MCP transport: stateless Streamable HTTP, JSON responses

## Status
Accepted (2026-10-10).

## Context
Workers are stateless and short-lived. The MCP SDK (`@modelcontextprotocol/sdk` 1.32.1) ships
`WebStandardStreamableHTTPServerTransport` for Fetch-API runtimes. The SDK's default JSON Schema validator
(Ajv) compiles with `new Function`, which Workers refuse.

## Decision
- `createMcpRoute({config, snapshot, engine?, getD1, path = "/mcp"})` returns a Hono app.
  `handleMcpRequest(request, d1, options)` is the framework-free core.
- **Per request:**
  - A new `McpServer` and transport are created for each request:
    `sessionIdGenerator: undefined` (stateless) and `enableJsonResponse: true`. No SSE streams and no session
    store.
  - JSON mode means every tool has finished before the response, and so before the audit write (ADR 0063).
- **Request handling:**
  - POST only; other methods get 405.
  - The body must be at most 1 MiB, otherwise 413.
  - Batches may hold at most 10 JSON-RPC messages.
  - Invalid JSON gets a JSON-RPC parse error (400).
  - Clients must send `Accept: application/json, text/event-stream`, as the spec requires.
- **Auth before MCP:** the bearer token is verified before any MCP processing, so unauthenticated requests never
  reach the SDK.
- **Mount order:** the blog mounts the route before `castraContext`, so sessions and API keys never apply on
  `/mcp`.
- **Validation:** the server and the test clients use a no-op `jsonSchemaValidator`. Input validation is done by
  each tool's zod schema; tools have no output schema.
- **Tool annotations:** every tool is registered with `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true` and `openWorldHint: false`.

## Consequences
- No server-initiated messages or resumability. That is acceptable for four request/response tools.
- The blog Worker bundle grows by the SDK: 3387 KiB, 586 KiB gzip with `wrangler deploy --dry-run`.
