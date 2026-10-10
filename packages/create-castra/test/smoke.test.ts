import { describe, expect, it } from "vitest";
import { name } from "../src/index.js";

describe("create-castra", () => {
  it("exports its package name", () => {
    expect(name).toBe("create-castra");
  });
});
