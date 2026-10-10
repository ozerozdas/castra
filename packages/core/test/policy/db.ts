import { env } from "cloudflare:workers";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { DDL } from "./fixtures.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function testDb(): Kysely<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Kysely<any>({ dialect: new D1Dialect({ database: env.DB }) });
}

export async function createTables(): Promise<void> {
  for (const stmt of DDL) await env.DB.prepare(stmt).run();
}
