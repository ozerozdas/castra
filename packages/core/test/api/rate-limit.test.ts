import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { rateLimitWrites, type RateLimiterLike } from "../../src/index.js";

/** A fake binding: allows `max` calls per key and records every key. */
function fakeLimiter(max: number) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const limiter: RateLimiterLike = {
    async limit({ key }) {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= max };
    },
  };
  return { limiter, keys };
}

function app(limiter: RateLimiterLike | undefined) {
  const a = new Hono();
  a.use("*", rateLimitWrites(() => limiter, 10));
  a.all("*", (c) => c.text("ok"));
  return a;
}

const ip = (addr: string) => ({ "cf-connecting-ip": addr });

describe("rateLimitWrites (ADR 0072)", () => {
  it("denies writes over the limit with a 429 problem and Retry-After", async () => {
    const { limiter } = fakeLimiter(2);
    const a = app(limiter);
    expect((await a.request("https://x.dev/api/auth/sign-in/email", { method: "POST", headers: ip("1.1.1.1") })).status).toBe(200);
    expect((await a.request("https://x.dev/mcp", { method: "POST", headers: ip("1.1.1.1") })).status).toBe(200);
    const res = await a.request("https://x.dev/api/notes/1", { method: "PATCH", headers: ip("1.1.1.1") });
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(await res.json()).toMatchObject({ status: 429, type: "https://castra.mehmetozer.dev/problems/rate_limited" });
  });

  it("allows another address and never limits reads", async () => {
    const { limiter, keys } = fakeLimiter(0);
    const a = app(limiter);
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect((await a.request("https://x.dev/api/notes", { method, headers: ip("1.1.1.1") })).status).toBe(200);
    }
    expect(keys).toEqual([]);
    expect((await a.request("https://x.dev/api/notes", { method: "POST", headers: ip("2.2.2.2") })).status).toBe(429);
  });

  it("keys on host and client IP", async () => {
    const { limiter, keys } = fakeLimiter(1);
    const a = app(limiter);
    expect((await a.request("https://one.dev/api/notes", { method: "POST", headers: ip("1.1.1.1") })).status).toBe(200);
    expect((await a.request("https://two.dev/api/notes", { method: "POST", headers: ip("1.1.1.1") })).status).toBe(200);
    expect(keys).toEqual(["one.dev:1.1.1.1", "two.dev:1.1.1.1"]);
  });

  it("does not limit without a client IP or without a binding; a missing binding warns once (ADR 0077)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { limiter, keys } = fakeLimiter(0);
    expect((await app(limiter).request("https://x.dev/api/notes", { method: "POST" })).status).toBe(200);
    expect(keys).toEqual([]);
    expect((await app(undefined).request("https://x.dev/api/notes", { method: "GET", headers: ip("1.1.1.1") })).status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      expect((await app(undefined).request("https://x.dev/api/notes", { method: "POST", headers: ip("1.1.1.1") })).status).toBe(200);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("RATE_LIMITER");
    warn.mockRestore();
  });
});
