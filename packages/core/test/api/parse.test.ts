import { describe, expect, it } from "vitest";
import { ApiError, decodeCursor, encodeCursor, parseFilter, parseRequest, type ParsedRequest } from "../../src/index.js";

function list(qs: string) {
  const p = parseRequest({ method: "GET", table: "posts", query: new URLSearchParams(qs) });
  if (p.kind !== "list") throw new Error("not list");
  return p;
}

function status(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e.status;
    throw e;
  }
  return 0;
}

describe("parseRequest: routing", () => {
  const q = new URLSearchParams();
  it.each<[string, string | undefined, unknown, ParsedRequest["kind"]]>([
    ["GET", undefined, undefined, "list"],
    ["GET", "1", undefined, "get"],
    ["POST", undefined, { a: 1 }, "create"],
    ["PATCH", "1", { a: 1 }, "update"],
    ["DELETE", "1", undefined, "delete"],
  ])("%s id=%s → %s", (method, id, body, kind) => {
    expect(parseRequest({ method, table: "posts", id, query: q, body }).kind).toBe(kind);
  });

  it("refuses bulk and unknown methods", () => {
    expect(status(() => parseRequest({ method: "PATCH", table: "posts", query: q, body: {} }))).toBe(405);
    expect(status(() => parseRequest({ method: "DELETE", table: "posts", query: q }))).toBe(405);
    expect(status(() => parseRequest({ method: "POST", table: "posts", id: "1", query: q, body: {} }))).toBe(405);
    expect(status(() => parseRequest({ method: "PUT", table: "posts", id: "1", query: q, body: {} }))).toBe(405);
  });

  it("requires a JSON object body", () => {
    for (const body of [null, [], "x", 1, undefined]) {
      expect(status(() => parseRequest({ method: "POST", table: "posts", query: q, body }))).toBe(400);
    }
  });

  it("rejects query params on writes and anything but include on a single row", () => {
    expect(status(() => parseRequest({ method: "POST", table: "posts", query: new URLSearchParams("a=eq.1"), body: {} }))).toBe(400);
    expect(status(() => parseRequest({ method: "GET", table: "posts", id: "1", query: new URLSearchParams("status=eq.x") }))).toBe(400);
    const g = parseRequest({ method: "GET", table: "posts", id: "1", query: new URLSearchParams("include=author") });
    expect(g).toEqual({ kind: "get", table: "posts", id: "1", include: ["author"] });
  });
});

describe("parseFilter: every operator", () => {
  it.each(["eq", "neq", "gt", "gte", "lt", "lte", "like"] as const)("%s keeps the raw value", (op) => {
    expect(parseFilter("c", `${op}.a.b`)).toEqual({ column: "c", op, value: "a.b" });
  });
  it("is accepts only null/true/false", () => {
    expect(parseFilter("c", "is.null")).toEqual({ column: "c", op: "is", value: "null" });
    expect(parseFilter("c", "is.true").value).toBe("true");
    expect(status(() => parseFilter("c", "is.1"))).toBe(400);
  });
  it("in parses plain and quoted items", () => {
    expect(parseFilter("c", 'in.(a,"b,c","d\\"e",)').value).toEqual(["a", "b,c", 'd"e', ""]);
    for (const bad of ["in.a,b", "in.()", 'in.("a)', 'in.(a"b)', 'in.("a"b)']) expect(status(() => parseFilter("c", bad))).toBe(400);
    const many = `in.(${Array.from({ length: 101 }, (_, i) => i).join(",")})`;
    expect(status(() => parseFilter("c", many))).toBe(400);
  });
  it("rejects unknown operators and missing dots", () => {
    for (const bad of ["ilike.x", "eq", "EQ.1", "match.x", ".x", "or.(a,b)"]) expect(status(() => parseFilter("c", bad))).toBe(400);
  });
  it("keeps injection-shaped values and column names as data (checked later)", () => {
    const f = list("title=eq.1' OR '1'='1&a%22%3B%20drop%20table%20posts--=eq.x");
    expect(f.filters).toEqual([
      { column: "title", op: "eq", value: "1' OR '1'='1" },
      { column: 'a"; drop table posts--', op: "eq", value: "x" },
    ]);
  });
});

describe("parseRequest: list options", () => {
  it("parses sort, limit, offset, count, include", () => {
    const p = list("sort=-created_at,title&limit=5&offset=10&count=exact&include=author,comments,author");
    expect(p.sort).toEqual([
      { column: "created_at", desc: true },
      { column: "title", desc: false },
    ]);
    expect([p.limit, p.offset, p.count, p.include]).toEqual([5, 10, true, ["author", "comments"]]);
  });
  it.each([
    "limit=0",
    "limit=-1",
    "limit=1.5",
    "limit=abc",
    "offset=100001",
    "count=planned",
    "sort=a,a",
    "sort=-",
    "sort=a,b,c,d,e,f",
    "include=a,,b",
    "limit=1&limit=2",
    "status=eq.a&status=eq.b&" + Array.from({ length: 20 }, (_, i) => `c${i}=eq.1`).join("&"),
  ])("400 for %s", (qs) => {
    expect(status(() => list(qs))).toBe(400);
  });
  it("cursor and offset cannot be combined", () => {
    const c = encodeCursor({ keys: ["id"], values: ["x"] });
    expect(status(() => list(`cursor=${c}&offset=1`))).toBe(400);
    expect(list(`cursor=${c}`).cursor).toEqual({ keys: ["id"], values: ["x"] });
  });
});

describe("cursor tampering", () => {
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  it("round-trips", () => {
    const c = { keys: ["-created_at", "id"], values: ["2026", "p1"] };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it.each([
    ["not base64", "!!!"],
    ["not json", btoa("nope")],
    ["array", enc([1])],
    ["extra key", enc({ k: ["id"], v: [1], x: 1 })],
    ["length mismatch", enc({ k: ["id", "a"], v: [1] })],
    ["empty", enc({ k: [], v: [] })],
    ["object value", enc({ k: ["id"], v: [{ $gt: 1 }] })],
    ["non-string key", enc({ k: [1], v: [1] })],
    ["too long", "a".repeat(3000)],
  ])("rejects %s", (_n, raw) => {
    expect(status(() => decodeCursor(raw))).toBe(400);
  });
});
