# Castra v0.1 — Current state

Date: 2026-10-11. `master` pushed to `origin`. No open worktrees.
Details: `docs/PROGRESS.md` (final state), `docs/SECURITY.md`, `README.md`, ADRs 0001–0067.

## Done

M0–M6 complete. Every milestone has a reviewer sign-off: reviews 1–5 plus a final adversarial review, all findings fixed.
The README quickstart (steps 1–5) was verified end to end locally.

Last full run on master:

```
pnpm install && pnpm -r build && pnpm lint && pnpm typecheck && pnpm -r test && pnpm test:policies
```

Exit 0. Test counts: core 779 · auth 20 · mcp 83 · cli 102 · create-castra 43 (+5 opt-in e2e skipped) + 28 template · blog 103 · test:policies 517.

## Left for a human (needs explicit approval)

1. Check that the npm names `castra`, `create-castra` and `@castra/*` are free, then publish. Until then `npx create-castra` does not work; use `--local-packages`.

## Since v0.1 work

- A scaffolded app (`mehmetozer-blog`) was deployed to a real account; live endpoints checked.
- Problem `type` URIs moved to `https://castra.mehmetozer.dev/problems/<code>` (ADR 0067). The pages are live,
  built from `site/problems.json` and deployed with `pnpm site:deploy`.

## Known issues

Listed in PROGRESS "Open issues" and SECURITY.md §3, including:

- no rate limiting on `/mcp`;
- audit log stores tool arguments verbatim;
- `access:check` reveals hidden column names;
- `castra init` is deferred (ADR 0038);
- `auth`/`storage` config keys are validated but not read in v0.1.
