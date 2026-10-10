import { validate } from "@readme/openapi-parser";
import { describe, expect, it } from "vitest";
import { generateOpenApi } from "../../src/index.js";
import { config, snapshot } from "./fixtures.js";

const doc = generateOpenApi({ config, snapshot });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const d = doc as any;

describe("OpenAPI 3.1", () => {
  it("is valid", async () => {
    const res = await validate(structuredClone(doc) as never);
    expect(res.valid ? [] : res.errors).toEqual([]);
    expect(d.openapi).toBe("3.1.0");
  });

  it("lists exactly the open operations", () => {
    const ops = Object.entries(d.paths as Record<string, Record<string, unknown>>).flatMap(([p, item]) =>
      Object.keys(item)
        .filter((m) => ["get", "post", "patch", "delete"].includes(m))
        .map((m) => `${m.toUpperCase()} ${p}`),
    );
    expect(ops.sort()).toEqual(
      [
        "GET /api/posts",
        "POST /api/posts",
        "GET /api/posts/{id}",
        "PATCH /api/posts/{id}",
        "DELETE /api/posts/{id}",
        "GET /api/comments",
        "POST /api/comments",
        "GET /api/comments/{id}",
        "PATCH /api/comments/{id}",
        "DELETE /api/comments/{id}",
        "GET /api/users",
        "GET /api/users/{id}",
        "GET /api/items",
        "POST /api/items",
        "GET /api/items/{id}",
        "PATCH /api/items/{id}",
      ].sort(),
    );
  });

  it("never mentions internal or unconfigured tables, or hidden fields", () => {
    const text = JSON.stringify(doc);
    for (const name of ["audit_logs", "_castra_roles", "verification", "password_hash", '"views"']) expect(text).not.toContain(name);
    expect(Object.keys(d.paths)).not.toContain("/api/user");
    expect(Object.keys(d.paths)).not.toContain("/api/session");
  });

  it("marks visibleTo fields optional and keeps server-set fields out of write schemas", () => {
    const posts = d.components.schemas.posts;
    expect(posts.properties.internal_notes).toBeDefined();
    expect(posts.required).not.toContain("internal_notes");
    expect(posts.required).toContain("title");
    const create = d.components.schemas.postsCreate;
    expect(create.additionalProperties).toBe(false);
    expect(Object.keys(create.properties)).not.toContain("author_id");
    expect(Object.keys(create.properties)).not.toContain("id");
    expect(d.components.schemas.users.required).not.toContain("email");
  });

  it("documents query params; the include enum has only includable relations", () => {
    const params = d.paths["/api/posts"].get.parameters as { name: string; schema: { items?: { enum?: string[] } } }[];
    const names = params.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["status", "created_at", "title", "sort", "limit", "cursor", "offset", "count", "include"]));
    expect(names).not.toContain("views");
    expect(names).not.toContain("internal_notes");
    expect(params.find((p) => p.name === "include")!.schema.items!.enum!.sort()).toEqual(["author", "comments"]);
  });
});
