import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run in the Workers runtime so schema/policy/query code is exercised against a real (miniflare) D1.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: { compatibilityDate: "2026-10-01", d1Databases: ["DB"] },
    }),
  ],
});
