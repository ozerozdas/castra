import { describe, expect, it } from "vitest";
import {
  ApiError,
  encodeCursor,
  parseRequest,
  PolicyError,
  planRequest,
  type CastraContext,
  type Plan,
  type PolicyEngine,
  toProblem,
} from "../../src/index.js";
import { anon, config, makeEngine, snapshot, user } from "./fixtures.js";

const engine = makeEngine();

function plan(method: string, table: string, qs = "", ctx: CastraContext = anon(), id?: string, body?: unknown, e: PolicyEngine = engine): Plan {
  return planRequest(e, snapshot, config, parseRequest({ method, table, id, query: new URLSearchParams(qs), body }), ctx);
}

function err(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (e) {
    // What a client sees (REST and MCP both go through toProblem).
    if (e instanceof ApiError || e instanceof PolicyError) return { status: toProblem(e).status, message: toProblem(e).detail };
    throw e;
  }
  throw new Error("expected an error");
}

const stmt = (p: Plan, name: string) => p.statements.find((s) => s.name === name)!;

describe("default closed: 404 for unknown, closed and internal tables", () => {
  it.each([
    ["GET", "nope"],
    ["GET", "audit_logs"],
    ["GET", "user"],
    ["GET", "session"],
    ["GET", "account"],
    ["GET", "verification"],
    ["GET", "_castra_roles"],
    ["DELETE", "comments_x"],
  ])("%s %s", (method, table) => {
    const e = err(() => plan(method, table, "", user("u1", ["admin"]), method === "DELETE" ? "1" : undefined));
    expect(e).toEqual({ status: 404, message: "The requested resource does not exist." });
  });
  it("closed operation on an open table is the same 404", () => {
    expect(err(() => plan("DELETE", "users", "", user("u1", ["admin"]), "u1")).status).toBe(404);
    expect(err(() => plan("POST", "users", "", user("u1", ["admin"]), undefined, {})).status).toBe(404);
  });
});

describe("list SQL shape", () => {
  it("always carries the policy WHERE and binds every value", () => {
    const p = plan("GET", "posts", "title=eq.x'--&sort=-created_at&count=exact");
    for (const name of ["list", "count"]) {
      const s = stmt(p, name);
      expect(s.sql).toContain('"status" = ?');
      expect(s.sql).not.toContain("x'--");
      expect(s.parameters).toContain("x'--");
      expect(s.parameters).toContain("published");
    }
    expect(stmt(p, "list").sql).toMatch(/order by "posts"\."created_at" desc, "posts"\."id" asc limit \?$/);
    expect(stmt(p, "list").parameters.at(-1)).toBe(26); // limit + 1
    expect(p.limit).toBe(25);
  });

  it("owner and admin get their own residuals", () => {
    expect(stmt(plan("GET", "posts", "", user("u1")), "list").parameters).toEqual(["published", "u1", 26]);
    expect(stmt(plan("GET", "posts", "", user("a", ["admin"])), "list").sql).toContain("1 = 1");
  });

  it("like escapes % _ \\ and maps * to %", () => {
    const s = stmt(plan("GET", "posts", "title=like.a*_%\\"), "list");
    expect(s.sql).toContain(`like ? escape '\\'`);
    expect(s.parameters).toContain("a%\\_\\%\\\\");
  });

  it("in and is", () => {
    const s = stmt(plan("GET", "posts", "status=in.(a,b)&created_at=is.null"), "list");
    expect(s.sql).toContain(`"posts"."status" in (select "value" from json_each(?))`);
    expect(s.parameters).toContain('["a","b"]');
    expect(s.sql).toContain(`"posts"."created_at" is null`);
  });

  it("clamps limit to maxLimit", () => {
    expect(plan("GET", "posts", "limit=1000").limit).toBe(100);
    expect(plan("GET", "posts", "limit=3").limit).toBe(3);
  });

  it("cursor becomes a bound keyset condition; a cursor for another sort is 400", () => {
    const c = encodeCursor({ keys: ["-created_at", "id"], values: ["2026", "p9"] });
    const s = stmt(plan("GET", "posts", `sort=-created_at&cursor=${c}`), "list");
    expect(s.parameters).toEqual(expect.arrayContaining(["2026", "p9"]));
    expect(s.sql).toContain('"status" = ?');
    expect(err(() => plan("GET", "posts", `sort=title&cursor=${c}`)).status).toBe(400);
    expect(err(() => plan("GET", "posts", `cursor=${encodeCursor({ keys: ["id"], values: [{}] as unknown[] })}`)).status).toBe(400);
  });
});

describe("filter / sort columns need canFilter (same 400 for hidden, visibleTo, unknown)", () => {
  const admin = user("a", ["admin"]);
  it.each(["views", "internal_notes", "nope", "body", 'x"; drop table posts'])("%s", (col) => {
    const f = err(() => plan("GET", "posts", `${encodeURIComponent(col)}=eq.1`, admin));
    const s = err(() => plan("GET", "posts", `sort=${encodeURIComponent(col)}`, admin));
    expect(f.status).toBe(400);
    expect(s.status).toBe(400);
    expect(f.message).toBe(`column "${col}" cannot be used for filtering`);
    expect(s.message).toBe(`column "${col}" cannot be used for sorting`);
  });
  it("allows configured filterable columns", () => {
    expect(() => plan("GET", "posts", "status=eq.draft&sort=created_at")).not.toThrow();
  });
  it("coerces values to the column type", () => {
    expect(err(() => plan("GET", "items", "score=eq.abc")).status).toBe(400);
  });
});

describe("includes", () => {
  it("one IN query per include, each under its own read policy", () => {
    const p = plan("GET", "posts", "include=author,comments", user("u1"));
    const author = stmt(p, "include:author");
    expect(author.sql).toContain(`"users"."id" in (select "value" from json_each(?))`);
    expect(author.parameters).toEqual(["$parentKeys"]);
    const comments = stmt(p, "include:comments");
    expect(comments.sql).toContain("row_number() over (partition by");
    expect(comments.parameters).toEqual(["$parentKeys", 25]);
    expect(p.explanations.map((e) => e.table)).toEqual(["posts", "users", "comments"]);
  });
  it("anonymous author include compiles to an empty filter", () => {
    expect(stmt(plan("GET", "posts", "include=author"), "include:author").sql).toContain("1 = 0");
  });
  it.each(["audit_logs", "nope", "user", "users", "posts"])("unknown include %s is 400", (inc) => {
    expect(err(() => plan("GET", "posts", `include=${inc}`)).message).toBe(`include "${inc}" is not available`);
  });
});

describe("constant-false rules", () => {
  it("401 anonymous, 403 authenticated", () => {
    expect(err(() => plan("GET", "users")).status).toBe(401);
    expect(err(() => plan("DELETE", "posts", "", user("u1"), "p1")).status).toBe(403);
    expect(err(() => plan("POST", "posts", "", anon(), undefined, { title: "t" })).status).toBe(401);
  });
});

describe("writes", () => {
  const body = { title: "t", body: "b", status: "draft", created_at: "c" };
  it("create: server UUID, server-set owner, no client PK", () => {
    const p = plan("POST", "posts", "", user("u1"), undefined, body);
    const ins = stmt(p, "insert");
    expect(ins.parameters).toContain("u1");
    expect(ins.parameters.at(-1)).toMatch(/^[0-9a-f-]{36}$/);
    expect(err(() => plan("POST", "posts", "", user("u1"), undefined, { ...body, id: "mine" })).status).toBe(400);
    expect(err(() => plan("POST", "posts", "", user("u1"), undefined, { ...body, author_id: "u2" })).status).toBe(403);
  });
  it("create: types and unknown / hidden columns give the same 400", () => {
    expect(err(() => plan("POST", "posts", "", user("u1"), undefined, { ...body, title: 1 })).status).toBe(400);
    const hidden = err(() => plan("POST", "posts", "", user("u1"), undefined, { ...body, views: 1 }));
    const unknown = err(() => plan("POST", "posts", "", user("u1"), undefined, { ...body, nope: 1 }));
    expect(hidden).toEqual({ status: 400, message: 'unknown column "views"' });
    expect(unknown).toEqual({ status: 400, message: 'unknown column "nope"' });
  });
  it("update plan: load, update (USING), guard, re-read", () => {
    const p = plan("PATCH", "posts", "", user("u1"), "p1", { title: "x" });
    expect(p.statements.map((s) => s.name)).toEqual(["load", "update", "guard", "reread"]);
    expect(stmt(p, "update").sql).toMatch(/^update "posts" set "title" = \? where/);
    expect(stmt(p, "update").sql).toContain('"posts"."author_id" = ?');
    expect(stmt(p, "guard").sql).toContain("castra_write_check_failed");
    expect(stmt(p, "guard").parameters).toContain("p1");
  });
  it("delete compiles the delete filter and the PK", () => {
    const s = stmt(plan("DELETE", "posts", "", user("a", ["admin"]), "p1"), "delete");
    expect(s.sql).toMatch(/^delete from "posts" where/);
    expect(s.parameters).toContain("p1");
  });
  it("JSON.stringify(plan) is the explain payload and contains no executable part", () => {
    const p = plan("GET", "posts");
    expect(Object.keys(JSON.parse(JSON.stringify(p)) as object).sort()).toEqual(["explanations", "includes", "kind", "limit", "op", "statements", "table"]);
  });
});
