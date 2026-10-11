## What and why

<!-- One or two sentences. Link the issue or discussion. -->

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm -r test && pnpm test:policies` pass
- [ ] Policy changes (`packages/core/src/policy`) come with allow **and** deny tests
- [ ] No string-built SQL; no secrets or real tokens in code or tests
- [ ] New error codes have a page in `site/problems.json`
- [ ] Docs in `docs/` updated if behaviour changed; ADR added if the design changed
