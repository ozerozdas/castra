import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAuthOptions } from "@castra/auth";
import { main, nextSteps, detectPackageManager, type RunCommandFn } from "../src/main.js";
import {
  CASTRA_PACKAGES,
  destinationName,
  localPackageSpecs,
  rewritePackageJson,
  scaffold,
  ScaffoldError,
  substituteName,
  TEMPLATE_DIR,
  UsageError,
  validateProjectName,
} from "../src/scaffold.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

let cwd: string;
let out: string[];
let err: string[];
let runs: { command: string; args: string[]; cwd: string }[];

const fakeRun =
  (code = 0): RunCommandFn =>
  async (command, args, dir) => {
    runs.push({ command, args, cwd: dir });
    return code;
  };

const create = (argv: string[], runCommand: RunCommandFn = fakeRun()) =>
  main(argv, { cwd, log: (l) => out.push(l), error: (l) => err.push(l), runCommand, env: {}, version: "9.9.9" });

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "create-castra-"));
  out = [];
  err = [];
  runs = [];
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("validateProjectName", () => {
  it.each(["my-app", "a", "app2", "a".repeat(63), "x-1-y"])("accepts %s", (name) => {
    expect(validateProjectName(name)).toBeNull();
  });
  it.each(["", "My-App", "-app", "app-", "my_app", "my app", "a".repeat(64), "../evil", "app/x", ".", "ünicode"])(
    "rejects %j",
    (name) => {
      expect(validateProjectName(name)).toMatch(/.+/);
    },
  );
});

describe("argument handling", () => {
  it("prints usage and exits 2 without a name", async () => {
    expect(await create([])).toBe(2);
    expect(err.join("\n")).toContain("Missing project name");
    expect(err.join("\n")).toContain("Usage: create-castra <name>");
  });

  it("exits 2 for an invalid name, extra positionals, unknown flags, templates or package managers", async () => {
    for (const argv of [["Bad_Name"], ["a", "b"], ["app", "--bogus"], ["app", "--template", "nope"], ["app", "--package-manager", "yarn"]]) {
      err = [];
      expect(await create(argv)).toBe(2);
      expect(err.join("\n")).toContain("Usage: create-castra");
    }
    expect(await readdir(cwd)).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("--help exits 0", async () => {
    expect(await create(["--help"])).toBe(0);
    expect(out.join("\n")).toContain("--local-packages");
  });

  it("refuses a non-empty target directory and leaves it untouched", async () => {
    await mkdir(join(cwd, "app"));
    await writeFile(join(cwd, "app", "keep.txt"), "mine");
    expect(await create(["app", "--no-install"])).toBe(1);
    expect(err.join("\n")).toContain("is not empty");
    expect(await readdir(join(cwd, "app"))).toEqual(["keep.txt"]);
  });

  it("accepts an existing empty directory", async () => {
    await mkdir(join(cwd, "app"));
    expect(await create(["app", "--no-install"])).toBe(0);
    expect(existsSync(join(cwd, "app", "wrangler.jsonc"))).toBe(true);
  });
});

describe("scaffolding", () => {
  it("copies the template, renames dotfiles and substitutes the name", async () => {
    expect(await create(["my-notes", "--no-install"])).toBe(0);
    const dir = join(cwd, "my-notes");

    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(dir, ".dev.vars.example"))).toBe(true);
    expect(existsSync(join(dir, "_gitignore"))).toBe(false);
    expect(existsSync(join(dir, "_dev.vars.example"))).toBe(false);
    for (const f of [
      "package.json",
      "wrangler.jsonc",
      "tsconfig.json",
      "castra.config.ts",
      "vitest.config.ts",
      "env.d.ts",
      "README.md",
      "src/index.ts",
      "test/policies.test.ts",
      "test/apply-migrations.ts",
      "migrations/0001_init.sql",
      "migrations/0002_auth.sql",
      "migrations/0003_mcp.sql",
      "castra/schema.json",
      "castra/db.d.ts",
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }

    const wrangler = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain(`"name": "my-notes"`);
    expect(wrangler).toContain(`"database_name": "my-notes-db"`);
    expect(wrangler).toContain(`"database_id": "00000000-0000-0000-0000-000000000000"`);
    expect(wrangler).toContain(`"binding": "DB"`);
    expect(wrangler).toContain("nodejs_compat");
    expect(wrangler).not.toContain("castra-app");

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-notes");
    for (const name of Object.keys(CASTRA_PACKAGES)) expect(pkg.dependencies[name]).toBe("9.9.9");
    expect(pkg.scripts["test:policies"]).toBe("castra test policies");
    expect(pkg.scripts.deploy).toBe("castra deploy");

    expect(await readFile(join(dir, "README.md"), "utf8")).not.toContain("castra-app");
    // Non-substituted files are copied byte for byte.
    expect(await readFile(join(dir, "castra.config.ts"), "utf8")).toBe(await readFile(join(TEMPLATE_DIR, "castra.config.ts"), "utf8"));
  });

  it("does not copy local state (node_modules, .wrangler, .dev.vars) from the template directory", async () => {
    const template = join(cwd, "tpl");
    await mkdir(join(template, "node_modules", "x"), { recursive: true });
    await mkdir(join(template, ".wrangler", "state"), { recursive: true });
    await writeFile(join(template, "node_modules", "x", "index.js"), "");
    await writeFile(join(template, ".wrangler", "state", "db"), "");
    await writeFile(join(template, ".dev.vars"), "BETTER_AUTH_SECRET=real");
    await writeFile(join(template, "package.json"), `{ "name": "castra-app", "dependencies": { "castra": "0.0.0" } }`);
    await writeFile(join(template, "_gitignore"), "node_modules/\n");
    const result = await scaffold({
      name: "x",
      targetDir: join(cwd, "x"),
      packageManager: "pnpm",
      castraVersion: "1.0.0",
      templateDir: template,
    });
    expect(result.files).toEqual([".gitignore", "package.json"]);
  });

  it("installs with the chosen package manager in the new directory and prints next steps", async () => {
    expect(await create(["app", "--package-manager", "npm"])).toBe(0);
    expect(runs).toEqual([{ command: "npm", args: ["install"], cwd: join(cwd, "app") }]);
    const text = out.join("\n");
    expect(text).toContain("cd app");
    expect(text).toContain("cp .dev.vars.example .dev.vars");
    expect(text).toContain("npm run db:migrate:local");
    expect(text).toContain("npm run dev");
    expect(text).toContain("CLOUDFLARE_API_TOKEN=... npm run deploy");
    expect(text).not.toContain("npm install");
  });

  it("--no-install skips the install and lists it in the next steps", async () => {
    expect(await create(["app", "--no-install", "--package-manager", "pnpm"])).toBe(0);
    expect(runs).toEqual([]);
    expect(out.join("\n")).toContain("pnpm install");
    // `pnpm deploy` is a built-in pnpm command; the script must be run with `pnpm run deploy`.
    expect(out.join("\n")).toContain("pnpm run deploy");
  });

  it("a failed install exits 1 but keeps the project", async () => {
    expect(await create(["app"], fakeRun(7))).toBe(1);
    expect(err.join("\n")).toContain("failed (exit 7)");
    expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
  });

  it("detects the package manager from npm_config_user_agent", () => {
    expect(detectPackageManager({ npm_config_user_agent: "npm/10.9.0 node/v22.0.0" })).toBe("npm");
    expect(detectPackageManager({ npm_config_user_agent: "pnpm/10.30.3 npm/? node/v22.0.0" })).toBe("pnpm");
    expect(detectPackageManager({})).toBe("pnpm");
    expect(nextSteps("a", "pnpm", true)[1]).toBe("  cd a");
  });
});

describe("--local-packages", () => {
  it("rewrites the Castra dependencies to link: paths into the repository for pnpm", async () => {
    expect(await create(["app", "--no-install", "--local-packages", REPO])).toBe(0);
    const pkg = JSON.parse(await readFile(join(cwd, "app", "package.json"), "utf8"));
    for (const [name, rel] of Object.entries(CASTRA_PACKAGES)) {
      expect(pkg.dependencies[name]).toBe(`link:${join(REPO, rel)}`);
    }
    // Third-party dependencies keep their registry versions.
    expect(pkg.dependencies.hono).toBe("4.13.13");
  });

  it("uses file: paths for npm", async () => {
    expect(await create(["app", "--no-install", "--package-manager", "npm", "--local-packages", REPO])).toBe(0);
    const pkg = JSON.parse(await readFile(join(cwd, "app", "package.json"), "utf8"));
    expect(pkg.dependencies.castra).toBe(`file:${join(REPO, "packages/core")}`);
  });

  it("rejects a path that is not a Castra repository (exit 1, nothing written)", async () => {
    expect(await create(["app", "--no-install", "--local-packages", cwd])).toBe(1);
    expect(err.join("\n")).toContain("expected a Castra repository");
    expect(existsSync(join(cwd, "app"))).toBe(false);
  });

  it("rewritePackageJson only touches Castra packages, in dependencies and devDependencies", () => {
    const text = JSON.stringify({ name: "t", dependencies: { castra: "0", hono: "1" }, devDependencies: { "@castra/cli": "0" } });
    const pkg = JSON.parse(rewritePackageJson(text, "n", { castra: "link:/x", "@castra/cli": "link:/y" }));
    expect(pkg).toEqual({ name: "n", dependencies: { castra: "link:/x", hono: "1" }, devDependencies: { "@castra/cli": "link:/y" } });
  });
});

describe("dotfiles and secrets", () => {
  it("maps only the underscore templates to dotfiles", () => {
    expect(destinationName("_gitignore")).toBe(".gitignore");
    expect(destinationName("_dev.vars.example")).toBe(".dev.vars.example");
    expect(destinationName("src/_gitignore")).toBe("src/_gitignore");
    expect(destinationName("README.md")).toBe("README.md");
  });

  it(".gitignore ignores .dev.vars, local state and build output", async () => {
    expect(await create(["app", "--no-install"])).toBe(0);
    const lines = (await readFile(join(cwd, "app", ".gitignore"), "utf8")).split("\n");
    for (const entry of [".dev.vars", ".wrangler/", "node_modules/", "dist/"]) expect(lines).toContain(entry);
  });

  it(".dev.vars.example holds no usable secret: its placeholder is rejected by @castra/auth", async () => {
    expect(await create(["app", "--no-install"])).toBe(0);
    expect(existsSync(join(cwd, "app", ".dev.vars"))).toBe(false);
    const text = await readFile(join(cwd, "app", ".dev.vars.example"), "utf8");
    const secret = /^BETTER_AUTH_SECRET=(.*)$/m.exec(text)?.[1];
    expect(secret).toBeDefined();
    expect(() => buildAuthOptions({ BETTER_AUTH_SECRET: secret! } as never, { roles: [] })).toThrow(/placeholder/);
    // GitHub credentials stay commented out.
    expect(text).not.toMatch(/^GITHUB_CLIENT_SECRET=./m);
  });
});

describe("name substitution", () => {
  it("replaces every template-name occurrence and nothing else", () => {
    expect(substituteName(`"name": "castra-app", "database_name": "castra-app-db" # castra`, "blog")).toBe(
      `"name": "blog", "database_name": "blog-db" # castra`,
    );
  });

  it("scaffold() validates the name itself (UsageError) and refuses a file as target (ScaffoldError)", async () => {
    await expect(
      scaffold({ name: "Bad", targetDir: join(cwd, "Bad"), packageManager: "pnpm", castraVersion: "1.0.0" }),
    ).rejects.toBeInstanceOf(UsageError);
    await writeFile(join(cwd, "file"), "x");
    await expect(
      scaffold({ name: "file", targetDir: join(cwd, "file"), packageManager: "pnpm", castraVersion: "1.0.0" }),
    ).rejects.toBeInstanceOf(ScaffoldError);
  });

  it("the README and wrangler.jsonc of a scaffolded project use its name", async () => {
    expect(await create(["shop-api", "--no-install"])).toBe(0);
    expect(await readFile(join(cwd, "shop-api", "README.md"), "utf8")).toMatch(/^# shop-api\n/);
    expect(await readFile(join(cwd, "shop-api", "README.md"), "utf8")).toContain("https://shop-api.");
  });
});

describe("--local-packages details", () => {
  it("resolves a relative path against the current directory and links @castra/cli too", async () => {
    expect(await create(["app", "--no-install", "--local-packages", relative(cwd, REPO)])).toBe(0);
    const pkg = JSON.parse(await readFile(join(cwd, "app", "package.json"), "utf8"));
    expect(pkg.dependencies["@castra/cli"]).toBe(`link:${join(REPO, "packages/cli")}`);
  });

  it("warns (but succeeds) when a local package has not been built", async () => {
    const repo = join(cwd, "fake-repo");
    for (const [pkg, rel] of Object.entries(CASTRA_PACKAGES)) {
      await mkdir(join(repo, rel), { recursive: true });
      await writeFile(join(repo, rel, "package.json"), JSON.stringify({ name: pkg }));
    }
    const { specs, warnings } = await localPackageSpecs(repo, "npm");
    expect(specs.castra).toBe(`file:${join(repo, "packages/core")}`);
    expect(warnings).toHaveLength(Object.keys(CASTRA_PACKAGES).length);
    expect(warnings[0]).toContain("pnpm -r build");
  });

  it("rejects a checkout whose package has another name", async () => {
    const repo = join(cwd, "fake-repo");
    for (const [pkg, rel] of Object.entries(CASTRA_PACKAGES)) {
      await mkdir(join(repo, rel), { recursive: true });
      await writeFile(join(repo, rel, "package.json"), JSON.stringify({ name: pkg === "castra" ? "not-castra" : pkg }));
    }
    await expect(localPackageSpecs(repo, "pnpm")).rejects.toThrow(/expected "castra"/);
  });
});
