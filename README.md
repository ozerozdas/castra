# Castra

[![CI](https://github.com/ozerozdas/castra/actions/workflows/ci.yml/badge.svg)](https://github.com/ozerozdas/castra/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@castra-kit/core?label=%40castra-kit%2Fcore)](https://www.npmjs.com/package/@castra-kit/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A self-hosted backend on Cloudflare: one Worker and one D1 database in **your** account serve REST endpoints for
your tables. Every endpoint is protected by policies written in TypeScript and compiled to SQL. An MCP server lets AI
agents inspect exactly what production enforces.

- **Closed by default.** A table without a policy has no routes.
- **Policies are SQL.** Rules become `WHERE` clauses, so pagination and counts stay correct.
- **Checked writes.** Every create and update is verified on the stored row, atomically.
- **Auth included.** Better Auth (email, GitHub), roles and API keys.
- **Agent-safe MCP.** Read-only tools on the same engine as REST, with scoped tokens and an audit log.

> **Status: v0.1.0** ([release notes](https://github.com/ozerozdas/castra/releases/tag/v0.1.0)). Early, but deployed
> and working. Read [Status and limits](docs/limits.md) before using it for anything important.

## Quick start

Requires Node 20+ and pnpm.

```sh
npm create @castra-kit@latest my-app
cd my-app
cp .dev.vars.example .dev.vars    # set BETTER_AUTH_SECRET: openssl rand -base64 32
pnpm db:migrate:local
pnpm dev                          # http://localhost:8787/health
```

Deploy to your Cloudflare account (token permissions: [docs/cloudflare-token.md](docs/cloudflare-token.md)):

```sh
CLOUDFLARE_API_TOKEN=... pnpm run deploy
```

The full walkthrough, including your first request and your first policy, is in
[Getting started](docs/getting-started.md).

## What a policy looks like

```ts
import { authenticated, defineConfig, isPublic, owner, role } from "@castra-kit/core";

export default defineConfig({
  database: "d1",
  roles: ["admin", "editor"],
  tables: {
    posts: {
      read: isPublic().where((q) => q.eb("status", "=", "published")).or(owner("author_id")),
      create: authenticated(),
      update: owner("author_id").or(role("editor", "admin")),
      delete: role("admin"),
      fields: { author_id: { setBy: "server" } },
    },
  },
});
// Any table not listed here is never exposed.
```

## Documentation

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Scaffold, run, first request, first policy, deploy |
| [Concepts and configuration](docs/concepts.md) | Rules, write checks, field rules, config reference |
| [REST API](docs/rest-api.md) | Routes, filters, sorting, pagination, includes, errors |
| [Auth](docs/auth.md) | Better Auth, sessions, roles, API keys |
| [MCP](docs/mcp.md) | Tools, local stdio server, remote `/mcp`, tokens and scopes |
| [CLI](docs/cli.md) | `castra generate`, `provision`, `migrate`, `deploy`, `doctor`, `mcp` |
| [Status and limits](docs/limits.md) | What is verified, D1 limits, what is out of scope |
| [Security](docs/SECURITY.md) | Threat model, guarantees, known issues |
| [Problem types](https://castra.mehmetozer.dev/problems/) | Every error code the API returns |
| [Architecture](docs/ARCHITECTURE.md) · [ADRs](docs/adr/) | Design and one record per decision |

Questions and ideas: [Discussions](https://github.com/ozerozdas/castra/discussions).
Troubleshooting and FAQ: [Wiki](https://github.com/ozerozdas/castra/wiki).

## Packages

| Package | |
| --- | --- |
| [`@castra-kit/core`](https://www.npmjs.com/package/@castra-kit/core) | Policy engine, schema snapshot, REST router, OpenAPI |
| [`@castra-kit/auth`](https://www.npmjs.com/package/@castra-kit/auth) | Better Auth wiring, roles, API keys |
| [`@castra-kit/mcp`](https://www.npmjs.com/package/@castra-kit/mcp) | MCP tools, stdio server, `/mcp` route |
| [`@castra-kit/cli`](https://www.npmjs.com/package/@castra-kit/cli) | The `castra` command |
| [`@castra-kit/create`](https://www.npmjs.com/package/@castra-kit/create) | Project scaffolder |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Mehmet Özer Özdaş
