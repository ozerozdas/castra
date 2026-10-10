import { ApiError } from "./problem.js";

/** Filter operators (ADR 0001). */
export const FILTER_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "like", "is"] as const;
/** A filter operator. */
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** Query parameters with a fixed meaning; every other parameter is a column filter. */
export const RESERVED_PARAMS = ["sort", "limit", "cursor", "offset", "count", "include"] as const;

/** Upper bounds on request shape, so one request cannot produce unbounded SQL. */
export const LIMITS = Object.freeze({
  filters: 20,
  inValues: 100,
  sortKeys: 5,
  includes: 10,
  cursorLength: 2048,
  maxOffset: 100_000,
  likeWildcards: 10,
  likeLength: 256,
});

/** One `?column=op.value` filter, syntactically parsed. Columns are checked later, by `planRequest`. */
export type ParsedFilter =
  | { column: string; op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; value: string }
  | { column: string; op: "like"; value: string }
  | { column: string; op: "in"; value: string[] }
  | { column: string; op: "is"; value: "null" | "true" | "false" };

/** One sort key from `?sort=`. */
export interface SortKey {
  column: string;
  desc: boolean;
}

/** A decoded `?cursor=`: the sort keys it was issued for and the last row's values for them. */
export interface RawCursor {
  /** Sort keys as `column` / `-column`, including the primary-key tie-breaker. */
  keys: string[];
  values: unknown[];
}

/** Input of {@link parseRequest}: a transport-neutral description of a REST call (REST and MCP share it). */
export interface RequestInput {
  method: string;
  table: string;
  id?: string | undefined;
  query: URLSearchParams;
  /** Parsed JSON body (POST/PATCH only). */
  body?: unknown;
}

/** List options shared by list requests. */
export interface ListOptions {
  filters: ParsedFilter[];
  sort: SortKey[];
  /** Requested page size; clamped to `maxLimit` by `planRequest`. */
  limit: number | undefined;
  cursor: RawCursor | undefined;
  offset: number | undefined;
  count: boolean;
  include: string[];
}

/** Output of {@link parseRequest}. */
export type ParsedRequest =
  | ({ kind: "list"; table: string } & ListOptions)
  | { kind: "get"; table: string; id: string; include: string[] }
  | { kind: "create"; table: string; body: Record<string, unknown> }
  | { kind: "update"; table: string; id: string; body: Record<string, unknown> }
  | { kind: "delete"; table: string; id: string };

function bad(message: string, code = "invalid_request"): ApiError {
  return new ApiError(400, code, message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/**
 * Parses a REST request into a {@link ParsedRequest}. Pure: no schema, policy or database access.
 * Validates syntax only (operators, value shapes, numbers, cursor encoding); column names, types and
 * policies are checked by `planRequest`. Throws {@link ApiError} (400, or 405 for unknown methods).
 */
export function parseRequest(input: RequestInput): ParsedRequest {
  const method = input.method.toUpperCase();
  const table = input.table;
  const id = input.id;
  if (typeof table !== "string" || table.length === 0) throw bad("missing table");
  if (id !== undefined && (typeof id !== "string" || id.length === 0)) throw bad("invalid id");
  const q = input.query;

  if (method === "GET" && id === undefined) return { kind: "list", table, ...parseListOptions(q) };
  if (method === "GET") {
    for (const key of new Set(q.keys())) if (key !== "include") throw bad(`query parameter "${key}" is not supported on a single row`);
    return { kind: "get", table, id: id!, include: parseInclude(q) };
  }
  if (method === "POST" || method === "PATCH" || method === "DELETE") {
    for (const key of new Set(q.keys())) throw bad(`query parameter "${key}" is not supported on ${method}`);
  }
  if (method === "POST") {
    if (id !== undefined) throw new ApiError(405, "method_not_allowed", "POST is only allowed on the collection");
    return { kind: "create", table, body: parseBody(input.body) };
  }
  if (method === "PATCH") {
    if (id === undefined) throw new ApiError(405, "method_not_allowed", "bulk updates are not supported");
    return { kind: "update", table, id, body: parseBody(input.body) };
  }
  if (method === "DELETE") {
    if (id === undefined) throw new ApiError(405, "method_not_allowed", "bulk deletes are not supported");
    return { kind: "delete", table, id };
  }
  throw new ApiError(405, "method_not_allowed", `method ${method} is not supported`);
}

function parseBody(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) throw bad("request body must be a JSON object", "invalid_body");
  return body;
}

function single(q: URLSearchParams, key: string): string | undefined {
  const all = q.getAll(key);
  if (all.length > 1) throw bad(`query parameter "${key}" given more than once`);
  return all[0];
}

function parseListOptions(q: URLSearchParams): ListOptions {
  const filters: ParsedFilter[] = [];
  for (const [key, value] of q) {
    if ((RESERVED_PARAMS as readonly string[]).includes(key)) continue;
    if (key.length === 0) throw bad("empty filter column", "invalid_filter");
    filters.push(parseFilter(key, value));
    if (filters.length > LIMITS.filters) throw bad(`at most ${LIMITS.filters} filters are allowed`, "invalid_filter");
  }

  const sort: SortKey[] = [];
  const sortRaw = single(q, "sort");
  if (sortRaw !== undefined) {
    const seen = new Set<string>();
    for (const part of sortRaw.split(",")) {
      const desc = part.startsWith("-");
      const column = desc ? part.slice(1) : part;
      if (column.length === 0) throw bad("invalid sort key", "invalid_sort");
      if (seen.has(column)) throw bad(`sort column "${column}" given more than once`, "invalid_sort");
      seen.add(column);
      sort.push({ column, desc });
    }
    if (sort.length > LIMITS.sortKeys) throw bad(`at most ${LIMITS.sortKeys} sort keys are allowed`, "invalid_sort");
  }

  const limit = parseNonNegativeInt(single(q, "limit"), "limit");
  if (limit === 0) throw bad("limit must be at least 1");
  const offset = parseNonNegativeInt(single(q, "offset"), "offset");
  if (offset !== undefined && offset > LIMITS.maxOffset) throw bad(`offset must be at most ${LIMITS.maxOffset}`);

  const cursorRaw = single(q, "cursor");
  const cursor = cursorRaw === undefined ? undefined : decodeCursor(cursorRaw);
  if (cursor && offset !== undefined) throw bad("cursor and offset cannot be combined");

  const countRaw = single(q, "count");
  if (countRaw !== undefined && countRaw !== "exact") throw bad('count must be "exact"');

  return { filters, sort, limit, cursor, offset, count: countRaw === "exact", include: parseInclude(q) };
}

function parseNonNegativeInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d{1,9}$/.test(raw)) throw bad(`${name} must be a non-negative integer`);
  return Number(raw);
}

function parseInclude(q: URLSearchParams): string[] {
  const raw = single(q, "include");
  if (raw === undefined) return [];
  const names = raw.split(",");
  if (names.some((n) => n.length === 0)) throw bad("invalid include list", "invalid_include");
  const unique = [...new Set(names)];
  if (unique.length > LIMITS.includes) throw bad(`at most ${LIMITS.includes} includes are allowed`, "invalid_include");
  return unique;
}

/** Parses one `op.value` filter expression (ADR 0001, ADR 0041). */
export function parseFilter(column: string, expr: string): ParsedFilter {
  const dot = expr.indexOf(".");
  if (dot < 0) throw bad(`filter "${column}": expected operator.value`, "invalid_filter");
  const op = expr.slice(0, dot);
  const value = expr.slice(dot + 1);
  switch (op) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return { column, op, value };
    case "like": {
      // SQLite rejects complex LIKE patterns ("LIKE or GLOB pattern too complex"); cap them up front.
      const wildcards = value.split("*").length - 1;
      if (value.length > LIMITS.likeLength || wildcards > LIMITS.likeWildcards) {
        throw bad(`filter "${column}": like pattern is too long or has too many wildcards`, "invalid_filter");
      }
      return { column, op, value };
    }
    case "is":
      if (value === "null" || value === "true" || value === "false") return { column, op, value };
      throw bad(`filter "${column}": is accepts null, true or false`, "invalid_filter");
    case "in":
      return { column, op, value: parseInList(column, value) };
    default:
      throw bad(`filter "${column}": unknown operator`, "invalid_filter");
  }
}

/**
 * Parses `(a,b,"c,d")`. Items may be double-quoted to contain commas or parentheses; inside quotes
 * `\"` and `\\` are escapes.
 */
function parseInList(column: string, raw: string): string[] {
  if (!raw.startsWith("(") || !raw.endsWith(")") || raw.length < 2) {
    throw bad(`filter "${column}": in expects (value,value,...)`, "invalid_filter");
  }
  const body = raw.slice(1, -1);
  const out: string[] = [];
  if (body.length === 0) throw bad(`filter "${column}": in needs at least one value`, "invalid_filter");
  let i = 0;
  for (;;) {
    let item = "";
    if (body[i] === '"') {
      i++;
      let closed = false;
      while (i < body.length) {
        const ch = body[i]!;
        if (ch === "\\" && i + 1 < body.length) {
          item += body[i + 1];
          i += 2;
        } else if (ch === '"') {
          i++;
          closed = true;
          break;
        } else {
          item += ch;
          i++;
        }
      }
      if (!closed || (i < body.length && body[i] !== ",")) throw bad(`filter "${column}": malformed quoted value`, "invalid_filter");
    } else {
      const end = body.indexOf(",", i);
      item = end < 0 ? body.slice(i) : body.slice(i, end);
      if (item.includes('"')) throw bad(`filter "${column}": malformed quoted value`, "invalid_filter");
      i = end < 0 ? body.length : end;
    }
    out.push(item);
    if (out.length > LIMITS.inValues) throw bad(`filter "${column}": at most ${LIMITS.inValues} values`, "invalid_filter");
    if (i >= body.length) break;
    i++; // skip the comma
    if (i >= body.length) {
      out.push("");
      break;
    }
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Encodes a cursor (opaque to clients; base64url JSON, ADR 0040). */
export function encodeCursor(cursor: RawCursor): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify({ k: cursor.keys, v: cursor.values })));
}

/** Decodes a cursor. Only its shape is checked here; `planRequest` checks it against the current sort. */
export function decodeCursor(raw: string): RawCursor {
  const invalid = () => bad("invalid cursor", "invalid_cursor");
  if (raw.length === 0 || raw.length > LIMITS.cursorLength) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromBase64Url(raw)));
  } catch {
    throw invalid();
  }
  if (!isPlainObject(parsed)) throw invalid();
  const { k, v } = parsed;
  if (Object.keys(parsed).length !== 2 || !Array.isArray(k) || !Array.isArray(v) || k.length !== v.length || k.length === 0) throw invalid();
  if (k.length > 16) throw invalid();
  if (!k.every((x) => typeof x === "string")) throw invalid();
  if (!v.every((x) => x === null || typeof x === "string" || (typeof x === "number" && Number.isFinite(x)))) throw invalid();
  return { keys: k as string[], values: v };
}
