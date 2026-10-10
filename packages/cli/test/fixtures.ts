/** Mirrors examples/blog/wrangler.jsonc: comments, placeholder id, no KV. */
export const BLOG_CONFIG = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "castra-blog",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "castra-blog",
      // Placeholder for local development only. \`castra provision\` replaces it with a real id.
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ]
}
`;

/** The blog config after provisioning (real-looking ids, CACHE present). */
export const PROVISIONED_CONFIG = BLOG_CONFIG.replace(
  "00000000-0000-0000-0000-000000000000",
  "6f1c0a3e-1111-4000-8000-000000000001",
).replace(
  `  "d1_databases": [`,
  `  "kv_namespaces": [{ "binding": "CACHE", "id": "0123456789abcdef0123456789abcdef" }],\n  "d1_databases": [`,
);
