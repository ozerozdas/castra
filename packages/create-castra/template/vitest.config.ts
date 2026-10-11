import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Paths relative to this file, so the config also works when vitest is started from another directory.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(here("./migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: here("./wrangler.jsonc") },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Generated per run; never a real secret.
            BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
            BETTER_AUTH_URL: "http://localhost",
          },
        },
      }),
    ],
    test: { setupFiles: [here("./test/apply-migrations.ts")], include: ["test/**/*.test.ts"] },
  };
});
