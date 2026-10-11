/**
 * verifyApiKey runs the same work for an unknown key id as for a known id with a wrong secret: one
 * SHA-256 and one constant-time comparison, against a dummy all-zero hash when no row exists
 * (SECURITY.md, "timing"). The comparison is spied on through its module.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/hash.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hash.js")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual), sha256Hex: vi.fn(actual.sha256Hex) };
});

const hash = await import("../src/hash.js");
const { verifyApiKey } = await import("../src/api-keys.js");

const KNOWN_ID = "0123456789abcdef";
const secret = (c: string) => c.repeat(43);
const keyFor = (id: string, s: string) => `castra_ak_${id}_${s}`;
const DUMMY = "0".repeat(64);

/** A D1 stand-in that answers the key lookup with `row` when the bound id matches. */
function fakeD1(row: Record<string, unknown>): D1Database {
  const statement = (params: unknown[]) => ({
    bind: (...p: unknown[]) => statement(p),
    all: async () => ({ results: params.includes(row.id) ? [row] : [], success: true, meta: {} }),
    run: async () => ({ results: [], success: true, meta: {} }),
    raw: async () => [],
    first: async () => null,
  });
  return { prepare: () => statement([]) } as unknown as D1Database;
}

let db: D1Database;
let storedHash: string;

beforeEach(async () => {
  vi.mocked(hash.timingSafeEqual).mockClear();
  vi.mocked(hash.sha256Hex).mockClear();
  storedHash = await hash.sha256Hex(keyFor(KNOWN_ID, secret("A")));
  vi.mocked(hash.sha256Hex).mockClear();
  db = fakeD1({ id: KNOWN_ID, user_id: "u1", key_hash: storedHash, roles: null, expires_at: null, revoked_at: null });
});

describe("verifyApiKey constant-time path", () => {
  it("allow: the right key verifies after one hash and one comparison", async () => {
    expect(await verifyApiKey(db, keyFor(KNOWN_ID, secret("A")))).toEqual({ id: KNOWN_ID, userId: "u1", roles: null });
    expect(hash.sha256Hex).toHaveBeenCalledTimes(1);
    expect(hash.timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("deny: a known id with a wrong secret is compared against the stored hash", async () => {
    const key = keyFor(KNOWN_ID, secret("B"));
    expect(await verifyApiKey(db, key)).toBeNull();
    expect(hash.timingSafeEqual).toHaveBeenCalledTimes(1);
    expect(hash.timingSafeEqual).toHaveBeenCalledWith(await hash.sha256Hex(key), storedHash);
  });

  it("deny: an unknown id still hashes and runs the comparison, against the dummy hash", async () => {
    const key = keyFor("fedcba9876543210", secret("A"));
    expect(await verifyApiKey(db, key)).toBeNull();
    expect(hash.sha256Hex).toHaveBeenCalledTimes(1);
    expect(hash.timingSafeEqual).toHaveBeenCalledTimes(1);
    const [computed, against] = vi.mocked(hash.timingSafeEqual).mock.calls[0]!;
    expect(computed).toMatch(/^[0-9a-f]{64}$/);
    expect(against).toBe(DUMMY);
    // Same length as a real stored hash, so the loop does the same number of iterations.
    expect(against.length).toBe(storedHash.length);
  });

  it("deny: a malformed key is rejected before any lookup or hashing", async () => {
    expect(await verifyApiKey(db, "castra_ak_nope")).toBeNull();
    expect(hash.sha256Hex).not.toHaveBeenCalled();
    expect(hash.timingSafeEqual).not.toHaveBeenCalled();
  });
});
