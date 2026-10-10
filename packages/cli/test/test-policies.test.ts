import { describe, expect, it } from "vitest";
import type { ExecFn, ExecOptions } from "../src/exec.js";
import { run } from "../src/run.js";

interface Call {
  command: string;
  args: string[];
  options: ExecOptions;
}

function harness(result: { code: number } | Error) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exec: ExecFn = async (command, args, options) => {
    calls.push({ command, args, options });
    if (result instanceof Error) throw result;
    return { code: result.code, stdout: "", stderr: "" };
  };
  const castra = (argv: string[]) =>
    run(argv, { cwd: "/project", exec, log: (l) => out.push(l), error: (l) => err.push(l) });
  return { calls, out, err, castra };
}

describe("castra test policies", () => {
  it("runs `vitest run policies` in the project directory and exits 0 when vitest passes", async () => {
    const h = harness({ code: 0 });
    expect(await h.castra(["test", "policies"])).toBe(0);
    expect(h.calls).toEqual([{ command: "vitest", args: ["run", "policies"], options: { cwd: "/project" } }]);
    expect(h.err).toEqual([]);
  });

  it("returns vitest's exit code when tests fail", async () => {
    const h = harness({ code: 1 });
    expect(await h.castra(["test", "policies"])).toBe(1);
    expect(h.err.join("\n")).toContain("Policy tests failed");
  });

  it("passes arguments after -- to vitest", async () => {
    const h = harness({ code: 0 });
    expect(await h.castra(["test", "policies", "--", "--reporter", "verbose"])).toBe(0);
    expect(h.calls[0]!.args).toEqual(["run", "policies", "--reporter", "verbose"]);
  });

  it("explains a missing vitest instead of crashing", async () => {
    const h = harness(Object.assign(new Error("spawn vitest ENOENT"), { code: "ENOENT" }));
    expect(await h.castra(["test", "policies"])).toBe(1);
    expect(h.err.join("\n")).toContain("Cannot run vitest");
  });

  it("rejects other subcommands with a usage error (exit 2) and never spawns", async () => {
    for (const argv of [["test"], ["test", "unit"], ["test", "policies", "extra"], ["test", "--bogus"]]) {
      const h = harness({ code: 0 });
      expect(await h.castra(argv)).toBe(2);
      expect(h.err.join("\n")).toContain("castra test policies");
      expect(h.calls).toEqual([]);
    }
  });

  it("prints usage with --help", async () => {
    const h = harness({ code: 0 });
    expect(await h.castra(["test", "--help"])).toBe(0);
    expect(h.out.join("\n")).toContain("Usage: castra test policies");
    expect(h.calls).toEqual([]);
  });
});
