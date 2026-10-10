import type { CastraConfig } from "../config.js";
import { createPolicyEngine, type PolicyEngine } from "../policy/engine.js";
import type { ColumnSnapshot, SchemaSnapshot } from "../types.js";
import { apiModel, INCLUDE_MANY_PER_PARENT, isBlobColumn, type ApiModel, type TableModel } from "./model.js";
import { FILTER_OPERATORS } from "./parse.js";

/** Options of {@link generateOpenApi}. */
export interface OpenApiOptions {
  config: CastraConfig;
  snapshot: SchemaSnapshot;
  /** Reuse an existing engine for the same config + snapshot. */
  engine?: PolicyEngine;
  /** Path prefix of the table routes. Default `/api`. */
  basePath?: string;
  /** `info.title`. Default `"Castra API"`. */
  title?: string;
  /** `info.version`. Default `"0.1.0"`. */
  version?: string;
}

/** A JSON object (the generated document is plain JSON). */
export type JsonObject = { [key: string]: unknown };

const ID_PATTERN = /[^A-Za-z0-9._-]/g;

function componentName(table: string): string {
  return table.replace(ID_PATTERN, "_");
}

function valueSchema(c: ColumnSnapshot, forWrite: boolean): JsonObject {
  let types: string[];
  const extra: JsonObject = {};
  if (isBlobColumn(c)) {
    types = ["string"];
    extra.contentEncoding = "base64";
  } else if (c.affinity === "TEXT") types = ["string"];
  else if (c.affinity === "INTEGER") types = ["integer"];
  else if (c.affinity === "REAL" || c.affinity === "NUMERIC") types = ["number"];
  else types = ["string", "number"];
  if (!c.notNull) types.push("null");
  void forWrite;
  return { type: types.length === 1 ? types[0] : types, ...extra };
}

/** Columns a client may send on create/update (static: no context needed). */
function writableColumns(t: TableModel, forCreate: boolean): ColumnSnapshot[] {
  return t.snapshot.columns.filter((c) => {
    if (t.hidden.has(c.name) || t.readonly.has(c.name) || t.server.has(c.name) || isBlobColumn(c)) return false;
    if (t.pk === c && (t.pkStrategy === "uuid" || t.pkStrategy === "rowid")) return false;
    if (!forCreate && t.pk === c) return false;
    return true;
  });
}

/** Relations includable by at least some caller: target readable, join columns not hidden. */
function includable(model: ApiModel, engine: PolicyEngine, t: TableModel) {
  return [...t.relations.values()].filter((r) => {
    const target = model.tables.get(r.target);
    return target !== undefined && engine.isOpen(r.target, "read") && !t.hidden.has(r.localColumn) && !target.hidden.has(r.targetColumn);
  });
}

/**
 * Generates the OpenAPI 3.1 document for a config + snapshot. It lists exactly the open operations
 * (table × operation with a rule; auth and internal tables never appear), so it is the same for
 * every caller. Read schemas omit `hidden` columns and leave `visibleTo` columns optional; write
 * schemas omit hidden, readonly, server-set and generated columns.
 */
export function generateOpenApi(options: OpenApiOptions): JsonObject {
  const { config, snapshot } = options;
  const engine = options.engine ?? createPolicyEngine({ config, snapshot });
  const model = apiModel(config, snapshot);
  const basePath = (options.basePath ?? "/api").replace(/\/+$/, "");
  const schemas: JsonObject = {
    Problem: {
      type: "object",
      required: ["type", "title", "status", "detail"],
      properties: {
        type: { type: "string" },
        title: { type: "string" },
        status: { type: "integer" },
        detail: { type: "string" },
      },
    },
  };
  const paths: JsonObject = {};
  const problem = (description: string) => ({
    description,
    content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
  });
  const errors = (...codes: number[]) => {
    const text: Record<number, string> = {
      400: "Invalid request",
      401: "Authentication required",
      403: "Not allowed",
      404: "Not found",
      409: "Conflict with the stored data",
      413: "Request body too large",
      415: "Body must be application/json",
    };
    return Object.fromEntries(codes.map((c) => [String(c), problem(text[c] ?? "Error")]));
  };

  const tableNames = [...model.tables.keys()].sort();
  for (const name of tableNames) {
    const t = model.tables.get(name)!;
    const open = {
      read: engine.isOpen(name, "read"),
      create: engine.isOpen(name, "create"),
      update: engine.isOpen(name, "update") && t.pk !== undefined,
      delete: engine.isOpen(name, "delete") && t.pk !== undefined,
    };
    if (!open.read && !open.create && !open.update && !open.delete) continue;
    const comp = componentName(name);
    const ref = { $ref: `#/components/schemas/${comp}` };
    const rels = open.read ? includable(model, engine, t) : [];

    // Read schema.
    const properties: JsonObject = {};
    const required: string[] = [];
    for (const c of t.snapshot.columns) {
      if (t.hidden.has(c.name)) continue;
      const s = valueSchema(c, false);
      if (t.visibleTo.has(c.name)) s.description = `Returned only to: ${t.visibleTo.get(c.name)!.join(", ")}.`;
      properties[c.name] = s;
      if (!t.visibleTo.has(c.name)) required.push(c.name);
    }
    for (const r of rels) {
      const targetRef = { $ref: `#/components/schemas/${componentName(r.target)}` };
      properties[r.name] =
        r.kind === "one"
          ? { description: `Present with ?include=${r.name}.`, oneOf: [targetRef, { type: "null" }] }
          : { description: `Present with ?include=${r.name}; at most ${INCLUDE_MANY_PER_PARENT} rows.`, type: "array", items: targetRef };
    }
    schemas[comp] = { type: "object", properties, required };

    if (open.create) {
      const cols = writableColumns(t, true);
      schemas[`${comp}Create`] = {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(cols.map((c) => [c.name, valueSchema(c, true)])),
        required: cols.filter((c) => c.notNull && c.defaultValue === null).map((c) => c.name),
      };
    }
    if (open.update) {
      const cols = writableColumns(t, false);
      schemas[`${comp}Update`] = {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: Object.fromEntries(cols.map((c) => [c.name, valueSchema(c, true)])),
      };
    }

    const includeParam = rels.length
      ? [
          {
            name: "include",
            in: "query",
            required: false,
            description: "Related rows to embed (one level), each under its own table's read policy.",
            style: "form",
            explode: false,
            schema: { type: "array", uniqueItems: true, items: { type: "string", enum: rels.map((r) => r.name) } },
          },
        ]
      : [];

    const collection: JsonObject = {};
    if (open.read) {
      const filterable = t.snapshot.columns.filter(
        (c) => !t.hidden.has(c.name) && !isBlobColumn(c) && (t.filterable === undefined || t.filterable.includes(c.name)),
      );
      const filterParams = filterable.map((c) => ({
        name: c.name,
        in: "query",
        required: false,
        description:
          `Filter, PostgREST style: \`op.value\` with op one of ${FILTER_OPERATORS.join(", ")} ` +
          "(e.g. `eq.x`, `in.(a,b)`, `is.null`, `like.*x*`)." +
          (t.visibleTo.has(c.name) ? ` Only for callers with one of the roles: ${t.visibleTo.get(c.name)!.filter((r) => r !== "self").join(", ")}.` : ""),
        schema: { type: "string" },
      }));
      collection.get = {
        operationId: `list_${comp}`,
        tags: [name],
        summary: `List ${name}`,
        parameters: [
          ...filterParams,
          {
            name: "sort",
            in: "query",
            required: false,
            description: `Comma-separated sort keys, \`-\` for descending. Sortable: ${filterable.map((c) => c.name).join(", ") || "none"}. The primary key is always appended.`,
            schema: { type: "string" },
          },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: model.maxLimit } },
          { name: "cursor", in: "query", required: false, description: "Opaque `nextCursor` of the previous page.", schema: { type: "string" } },
          { name: "offset", in: "query", required: false, description: "Offset pagination; cannot be combined with cursor.", schema: { type: "integer", minimum: 0 } },
          { name: "count", in: "query", required: false, schema: { type: "string", enum: ["exact"] } },
          ...includeParam,
        ],
        responses: {
          "200": {
            description: "A page of rows",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "nextCursor"],
                  properties: {
                    data: { type: "array", items: ref },
                    nextCursor: { type: ["string", "null"] },
                    count: { type: "integer", description: "With ?count=exact: total rows matching policy and filters." },
                  },
                },
              },
            },
          },
          ...errors(400, 401, 403, 404),
        },
      };
    }
    if (open.create) {
      collection.post = {
        operationId: `create_${comp}`,
        tags: [name],
        summary: `Create a row in ${name}`,
        requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${comp}Create` } } } },
        responses: {
          "201": {
            description: "Created. The row as the caller may read it, or only its primary key when the caller cannot read it.",
            content: { "application/json": { schema: { type: "object" } } },
          },
          ...errors(400, 401, 403, 404, 409, 413, 415),
        },
      };
    }
    if (Object.keys(collection).length) paths[`${basePath}/${name}`] = collection;

    if (t.pk && (open.read || open.update || open.delete)) {
      const item: JsonObject = {
        parameters: [{ name: "id", in: "path", required: true, schema: valueSchema({ ...t.pk, notNull: true }, false) }],
      };
      if (open.read) {
        item.get = {
          operationId: `get_${comp}`,
          tags: [name],
          summary: `Get one row of ${name}`,
          parameters: includeParam,
          responses: { "200": { description: "The row", content: { "application/json": { schema: ref } } }, ...errors(400, 401, 403, 404) },
        };
      }
      if (open.update) {
        item.patch = {
          operationId: `update_${comp}`,
          tags: [name],
          summary: `Update one row of ${name}`,
          requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${comp}Update` } } } },
          responses: {
            "200": {
              description: "Updated. The row as the caller may read it, or only its primary key.",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...errors(400, 401, 403, 404, 409, 413, 415),
          },
        };
      }
      if (open.delete) {
        item.delete = {
          operationId: `delete_${comp}`,
          tags: [name],
          summary: `Delete one row of ${name}`,
          responses: { "204": { description: "Deleted" }, ...errors(401, 403, 404, 409) },
        };
      }
      if (Object.keys(item).length > 1) paths[`${basePath}/${name}/{id}`] = item;
    }
  }

  return {
    openapi: "3.1.0",
    info: { title: options.title ?? "Castra API", version: options.version ?? "0.1.0" },
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Better Auth session token or a Castra API key." },
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
    },
    security: [{}, { bearerAuth: [] }, { apiKey: [] }],
  };
}
