# 0086. MCP migration tools: `generate_migration` / `apply_migration`

## Status
Accepted (2026-10-19, pending release). Issue [#20](https://github.com/ozerozdas/castra/issues/20).

## Context
ARCHITECTURE §5 lists MCP tools for `generate_migration` and `apply_migration`; v0.3 deferred them.
ADR 0080 ships `castra migrate create`, `status`, `apply` with wrangler as the runner. ADR 0081 kept
migrations out of the write-tools scope. ADR 0082 established the local-only, diff-only pattern for
tool output. Today an agent cannot create or apply a migration through MCP at all; the operator runs
the CLI by hand. This ADR opens that bridge without bypassing the policy engine, audit layer, or
wrangler.

## Decision
- **Local only.** Two new MCP tools, `generate_migration` and `apply_migration`, register only for
  `castra mcp` stdio. The remote `/mcp` route never registers them: a token holder must not mutate
  schema, and `data:write` is not enough (ADR 0081).
- **Option-gated.** `createCastraMcpServer` and `serveStdio` register the tools only when the CLI
  provides a `migrations` callback, exactly like `propose_policy` / `deploy_status`.
- `apply_migration` runs only against the local D1 (mirroring NEXT-STEPS §3: "start locally and keep
  remote mutation outside the initial tool scope"). The CLI callback hardcodes `target: "local"`; the
  input schema has no `remote` field. Remote mutation, if ever added, requires the same scope-gating
  as `data:write` plus a `beforeWrite` audit row.
- `generate_migration { name }` returns the path of the file it just wrote plus the file body as a
  `preview`, mirroring `propose_policy`'s `path/diff/next` shape. It delegates to `castra migrate create`
  (ADR 0080) and reads the file once for the body. It never accepts SQL from the caller; the comment
  header is the template. Refusals: empty string `name` → MCP SDK protocol-level input validation (the
  schema enforces `z.string().min(1)`); whitespace-only or otherwise empty after slug → 400 `invalid_name`;
  missing wrangler config → 400 `wrangler_config_not_found`; `migrations_pattern` binding → 400
  `migrations_pattern_unsupported`.
- `apply_migration { approve }` runs `migrateStatus` first and returns the result. With `approve: false`
  (or absent, or non-boolean) the tool returns 200 with `{ outcome: "ok", data: { approved: false,
  applied: [], pending: [...], unknown: [...], hint: "Pass { approve: true } to apply." } }`. With
  `approve: true` it refuses if the snapshot-drift check fails (`generate({ check: true })` returns
  non-zero), otherwise it shells out to `wrangler d1 migrations apply` via a wrapped `exec` with
  `echo: false` so wrangler stdout never enters the MCP stdio stream. Wrangler's exit code is reported
  verbatim; after a successful local apply the result includes `next: "Run \`castra generate\` to
  refresh castra/."`.
- **Wrangler stays the runner.** The tool never executes migration SQL itself. This preserves the single
  source of truth (ADR 0080) and the wrangler-managed `d1_migrations` table.
- **No new audit code.** Local stdio writes no `_castra_audit` rows today (`docs/mcp.md`); these tools
  are local-only and do not change that. A future remote version would have to register in `WRITE_TOOLS`
  and `TOOL_SCOPES` and emit an `attempt` row through `access.beforeWrite` (ADR 0081); this ADR defers that.
- Field rules and other table options are not part of these tools; only the SQL file.

## Consequences
- The tool is invoked by a developer at the keyboard. Approval is a JSON boolean, not a token or
  signature; the threat model is "agent proposes apply, developer confirms in the chat", not "agent
  approves itself".
- The diff preview in `generate_migration` is a comment header, not SQL; an agent that wants a SQL body
  must write it by hand into the created file, then call `apply_migration`.
- The tool refuses on `migrations_pattern` to keep the surface small; nested layouts keep using
  `wrangler d1 migrations create/list` directly.
- A failed wrangler apply is reported as a 500 `wrangler_failed` with the exit code, not hidden in a
  generic MCP error.
- The option gate keeps remote `/mcp` code paths from ever seeing `MigrationCallbacks`; the CLI-to-MCP
  dependency direction stays the same and the Worker bundle does not carry migration helpers.
- Because wrangler is still the runner, the `d1_migrations` table and any wrangler-specific errors
  remain authoritative; the MCP layer only transports them.
