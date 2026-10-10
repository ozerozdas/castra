# 0065. `castra mcp`: config loading and local identity

## Status
Accepted (2026-10-10). Narrows ARCHITECTURE §5 "Local" for v0.1.

## Context
The stdio server needs the user's `castra.config.ts`, which contains rule objects (functions, not JSON). It also
needs the committed snapshot and a database.

## Decision
- **Usage:** `castra mcp [--config castra.config.ts] [--wrangler wrangler.jsonc] [--binding] [--out castra]`.
  Here `--config` is the Castra config. For every other command, and for `castra mcp token`, `--config` is the
  wrangler config, as before.
- **Config loading:** the config is loaded with a native `import()`. For `.ts`, that relies on Node's built-in
  type stripping (Node >= 22.18, on by default). Older Node gets a clear error telling it to use a `.js`/`.mjs`
  config. No jiti or esbuild dependency.
- **Database:** the snapshot is read from `castra/schema.json` (run `castra generate` first). The database is
  the LOCAL D1 through wrangler's `getPlatformProxy` (ADR 0011).
- **stdout:** stdout is reserved for the protocol. `console.log`, `info` and `debug` are redirected to stderr.
- **Shutdown:** the process ends when stdin closes.
- **Identity:** local `as` may impersonate anyone (ADR 0061). Calls go through the same engine (ADR 0060).
- **Module identity:** rules are recognized by `instanceof` plus a module-private symbol. The config and the
  CLI must therefore resolve the same `castra` module. In a normal project there is one `castra` in
  `node_modules`, so this holds.

## Consequences
- ARCHITECTURE §5 also mentions using the Cloudflare API token for local MCP against the remote database. That
  is not built in v0.1; `castra mcp` is local-D1 only. Remote reads go through `/mcp` with a scoped token.
- With two copies of `castra`, rules from the config are not recognized as rules by the engine. That fails
  closed (an error at startup), never by opening a table. Not covered by a dedicated test.
