import { describe, expect, it } from "vitest";
import { name } from "../src/index.js";

describe("@castra/auth", () => {
  it("exports its package name", () => {
    expect(name).toBe("@castra/auth");
  });
});
