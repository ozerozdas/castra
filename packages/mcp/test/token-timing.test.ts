/**
 * verifyMcpToken runs the same work for an unknown token id as for a known id with a wrong secret: one
 * SHA-256 and one constant-time comparison, against a dummy all-zero hash when no row exists
 * (SECURITY.md, "timing"). The comparison from @castra/auth is spied on through a module mock.
 */
import * as auth from "@castra/auth";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpToken, verifyMcpToken } from "../src/index.js";
import { setup, testDb, USERS } from "./fixtures.js";

vi.mock("@castra/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@castra/auth")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const DUMMY = "0".repeat(64);
let token: string;
let tokenId: string;

beforeAll(async () => {
  await setup();
  const created = await createMcpToken(testDb(), { userId: USERS.alice, scopes: ["schema:read"] });
  token = created.token;
  tokenId = created.id;
});

beforeEach(() => {
  vi.mocked(auth.timingSafeEqual).mockClear();
});

/** Same id, different secret of the same shape. */
function wrongSecret(t: string): string {
  const secret = t.slice(-43);
  return t.slice(0, -43) + (secret[0] === "A" ? "B" : "A") + secret.slice(1);
}

describe("verifyMcpToken constant-time path", () => {
  it("allow: the right token verifies after one comparison", async () => {
    const r = await verifyMcpToken(testDb(), token);
    expect(r.ok).toBe(true);
    expect(auth.timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("deny: a known id with a wrong secret is compared against the stored hash", async () => {
    const r = await verifyMcpToken(testDb(), wrongSecret(token));
    expect(r).toMatchObject({ ok: false, reason: "invalid", tokenId });
    expect(auth.timingSafeEqual).toHaveBeenCalledTimes(1);
    const [, against] = vi.mocked(auth.timingSafeEqual).mock.calls[0]!;
    expect(against).toBe(await auth.sha256Hex(token));
  });

  it("deny: an unknown id still runs the comparison, against the dummy hash of the same length", async () => {
    const unknown = token.replace(tokenId, tokenId === "0123456789abcdef" ? "fedcba9876543210" : "0123456789abcdef");
    const r = await verifyMcpToken(testDb(), unknown);
    expect(r).toEqual({ ok: false, reason: "unknown", tokenId: null, userId: null });
    expect(auth.timingSafeEqual).toHaveBeenCalledTimes(1);
    const [computed, against] = vi.mocked(auth.timingSafeEqual).mock.calls[0]!;
    expect(computed).toMatch(/^[0-9a-f]{64}$/);
    expect(against).toBe(DUMMY);
  });

  it("deny: a malformed token is rejected before any comparison", async () => {
    expect(await verifyMcpToken(testDb(), "castra_mcp_nope")).toMatchObject({ ok: false, reason: "malformed" });
    expect(auth.timingSafeEqual).not.toHaveBeenCalled();
  });
});
