// Minimal typing for the bindings the "d1" vitest project provides (see vitest.config.ts).
// Kept local so the Node-typed core package does not pull in @cloudflare/workers-types globals.
declare module "cloudflare:workers" {
  import type { D1Database } from "@cloudflare/workers-types";
  export const env: { DB: D1Database };
}
