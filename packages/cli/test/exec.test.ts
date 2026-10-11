import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnExec } from "../src/exec.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "castra-exec-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("spawnExec (R5-4)", () => {
  it("passes input on stdin and returns the exit code and output", async () => {
    const r = await spawnExec(
      process.execPath,
      ["-e", "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{process.stdout.write(s.toUpperCase());process.exit(3)})"],
      { cwd: dir, input: "secret", echo: false },
    );
    expect(r).toEqual({ code: 3, stdout: "SECRET", stderr: "" });
  });

  it("a child that exits without reading a large stdin (EPIPE) does not crash; its exit code is returned", async () => {
    const r = await spawnExec(process.execPath, ["-e", "process.exit(7)"], {
      cwd: dir,
      input: "x".repeat(16 * 1024 * 1024),
      echo: false,
    });
    expect(r.code).toBe(7);
  });
});
