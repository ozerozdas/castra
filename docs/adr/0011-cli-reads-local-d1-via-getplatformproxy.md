# 0011. CLI reads the local D1 through `getPlatformProxy`

## Status
Accepted (2026-10-10).

## Context
`castra generate --local` must run the introspection queries against the local D1 database that
`wrangler d1 migrations apply --local` and `wrangler dev` write to (`.wrangler/state/v3`). Two options:

1. Shell out to `wrangler d1 execute <db> --local --json --command ...` per statement.
2. Import `wrangler` and use `getPlatformProxy`, which starts miniflare on the same persisted state and hands back a
   real `D1Database` binding.

## Decision
Use `getPlatformProxy({ configPath, persist: { path: <config dir>/.wrangler/state/v3 }, remoteBindings: false })`
and run the queries with the binding's `prepare().bind().all()`. `wrangler` is a peer dependency of
`@castra/cli` (`>=4`) and loaded with a dynamic import so a clear error is shown when missing.

Reasons: introspection needs one statement per table plus per index (dozens), and `wrangler d1 execute` costs a
process start each; parameters and JSON results come for free with the binding; no parsing of CLI output whose
format can change. Measured: opening the proxy and the first query take about 250 ms on the blog example.
`remoteBindings: false` guarantees no Cloudflare API access or token is needed.

The database is opened behind an injectable `OpenDatabaseFn`, so tests and later commands (`deploy` drift check
against a remote database via the D1 HTTP API) can swap the transport; `introspect` only needs a `QueryFn`.

## Consequences
- The persist path is derived from the config location, matching wrangler's default for a config in the project
  root. A custom `--persist-to` is not supported yet.
- `wrangler` is heavy to install, but it is already a requirement of every Castra project.
- Remote introspection (`generate` without `--local`, deploy drift check) is not implemented; `--local` is accepted
  and implied.
