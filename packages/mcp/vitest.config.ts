import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// All tests run inside workerd with a real local D1 binding `DB`, the runtime the remote /mcp route
// runs in. The stdio entry is tested end to end by @castra-kit/cli (spawning `castra mcp`).
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
      },
    }),
  ],
});
