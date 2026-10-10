// Prints the SQLite DDL Better Auth needs for Castra's exact auth configuration.
// Usage: pnpm --filter @castra/auth build && node packages/auth/scripts/generate-auth-schema.mjs
// Runs against an in-memory node:sqlite database (same SQLite dialect as D1); no network, no secrets.
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { buildAuthOptions } from "../dist/index.js";

const options = buildAuthOptions(
  {
    DB: new DatabaseSync(":memory:"),
    BETTER_AUTH_SECRET: "schema-generation-only-not-a-secret-000000",
    // GitHub adds no tables, but enable it so the schema matches a fully configured deployment.
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
  },
  { roles: [] },
);
const { compileMigrations } = await getMigrations(options);
process.stdout.write(`${await compileMigrations()}\n`);
