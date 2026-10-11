import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("app", () => {
  it("GET /health returns { ok: true }", async () => {
    const res = await exports.default.fetch("http://localhost/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("unknown routes answer application/problem+json", async () => {
    const res = await exports.default.fetch("http://localhost/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  });
});
