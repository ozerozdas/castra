import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: { entry: ["src/index.ts"] },
  clean: true,
  sourcemap: true,
  target: "es2022",
  // Only the bin needs the shebang, but it is harmless in the library entry.
  banner: { js: "#!/usr/bin/env node" },
});
