import { afterEach, beforeEach, vi } from "vitest";
import type { ExecFn, ExecOptions } from "../src/exec.js";

/** A recorded API call. */
export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Permission families the fake can deny (HTTP 403, code 10000). */
export type Family = "workers" | "d1" | "kv" | "r2" | "accounts" | "tokens";

/** Fake token value used by every test. Not a real credential. */
export const FAKE_TOKEN = "test-token-not-real";

/**
 * In-memory stand-in for the Cloudflare REST API. Only `https://api.cloudflare.com/client/v4/...` is answered;
 * any other URL, or an unknown route, throws, so a test can never silently reach the network.
 */
export class FakeCloudflare {
  calls: Call[] = [];
  accounts = [{ id: "acc1", name: "Test Account" }];
  tokenStatus = "active";
  /** "user" tokens pass /user/tokens/verify; "account" tokens only the account endpoint. */
  tokenKind: "user" | "account" = "user";
  tokenValid = true;
  denied = new Set<Family>();
  /** Permission group names returned by GET .../tokens/{id}; null = the token cannot read itself (403). */
  policyNames: string[] | null = null;
  d1: { uuid: string; name: string }[] = [];
  kv: { id: string; title: string }[] = [];
  r2: { name: string }[] = [];
  /** Worker name -> secret names. Absent = Worker does not exist. */
  secrets = new Map<string, string[]>();
  subdomain = "testsub";
  /** Rows returned for D1 HTTP queries, keyed by SQL. */
  d1Query: (sql: string, params: unknown[]) => Record<string, unknown>[] = () => [];
  private seq = 0;

  get posts(): Call[] {
    return this.calls.filter((c) => c.method === "POST" && !c.path.endsWith("/query"));
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.origin !== "https://api.cloudflare.com" || !url.pathname.startsWith("/client/v4/")) {
      throw new Error(`Unexpected network call to ${input}`);
    }
    const method = init?.method ?? "GET";
    const path = url.pathname.slice("/client/v4".length);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: path + url.search, body });
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${FAKE_TOKEN}` || !this.tokenValid) return this.fail(401, 1000, "Invalid API Token");
    return this.route(method, path, url.searchParams, body);
  };

  private ok(result: unknown, info?: unknown): Response {
    return Response.json({ success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
  }

  private fail(status: number, code: number, message: string): Response {
    return Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
  }

  private deny(family: Family): Response | undefined {
    return this.denied.has(family) ? this.fail(403, 10000, "Authentication error") : undefined;
  }

  private route(method: string, path: string, q: URLSearchParams, body: Record<string, unknown> | undefined): Response {
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/user/tokens/verify") {
      if (this.tokenKind !== "user") return this.fail(401, 1000, "Invalid API Token");
      return this.ok({ id: "tok1", status: this.tokenStatus });
    }
    if (method === "GET" && /^\/accounts\/[^/]+\/tokens\/verify$/.test(path)) {
      return this.ok({ id: "tok1", status: this.tokenStatus });
    }
    if (method === "GET" && (path === "/user/tokens/tok1" || /^\/accounts\/[^/]+\/tokens\/tok1$/.test(path))) {
      if (this.policyNames === null) return this.fail(403, 9109, "Unauthorized to access requested resource");
      return this.ok({
        id: "tok1",
        policies: [
          {
            effect: "allow",
            resources: { [`com.cloudflare.api.account.${this.accounts[0]!.id}`]: "*" },
            permission_groups: this.policyNames.map((name, i) => ({ id: `g${i}`, name })),
          },
        ],
      });
    }
    if (method === "GET" && path === "/accounts") return this.deny("accounts") ?? this.ok(this.accounts);

    if (/^\/accounts\/[^/]+\/d1\/database$/.test(path)) {
      const denied = this.deny("d1");
      if (denied) return denied;
      if (method === "GET") {
        const name = q.get("name");
        const page = Number(q.get("page") ?? 1);
        const perPage = Number(q.get("per_page") ?? 100);
        const all = name ? this.d1.filter((d) => d.name.includes(name)) : this.d1;
        return this.ok(all.slice((page - 1) * perPage, page * perPage));
      }
      if (method === "POST") {
        const db = { uuid: `d1-uuid-${++this.seq}`, name: String(body?.name) };
        this.d1.push(db);
        return this.ok(db);
      }
    }
    if (/^\/accounts\/[^/]+\/d1\/database\/[^/]+\/query$/.test(path) && method === "POST") {
      return this.deny("d1") ?? this.ok([{ results: this.d1Query(String(body?.sql), (body?.params as unknown[] | undefined) ?? []), success: true }]);
    }
    if (/^\/accounts\/[^/]+\/storage\/kv\/namespaces$/.test(path)) {
      const denied = this.deny("kv");
      if (denied) return denied;
      if (method === "GET") {
        const page = Number(q.get("page") ?? 1);
        const perPage = Number(q.get("per_page") ?? 100);
        return this.ok(this.kv.slice((page - 1) * perPage, page * perPage));
      }
      if (method === "POST") {
        const ns = { id: `kv${++this.seq}`.padEnd(32, "a"), title: String(body?.title) };
        this.kv.push(ns);
        return this.ok(ns);
      }
    }
    if (/^\/accounts\/[^/]+\/r2\/buckets$/.test(path)) {
      const denied = this.deny("r2");
      if (denied) return denied;
      if (method === "GET") {
        const contains = q.get("name_contains") ?? "";
        return this.ok({ buckets: this.r2.filter((b) => b.name.includes(contains)) }, { per_page: 1000 });
      }
      if (method === "POST") {
        const b = { name: String(body?.name) };
        this.r2.push(b);
        return this.ok(b);
      }
    }
    if (method === "GET" && /^\/accounts\/[^/]+\/workers\/scripts$/.test(path)) {
      return this.deny("workers") ?? this.ok([...this.secrets.keys()].map((id) => ({ id })));
    }
    if (method === "GET" && (m = path.match(/^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/secrets$/))) {
      const denied = this.deny("workers");
      if (denied) return denied;
      const names = this.secrets.get(decodeURIComponent(m[1]!));
      if (names === undefined) return this.fail(404, 10007, "This Worker does not exist on your account.");
      return this.ok(names.map((name) => ({ name, type: "secret_text" })));
    }
    if (method === "GET" && /^\/accounts\/[^/]+\/workers\/subdomain$/.test(path)) {
      return this.deny("workers") ?? this.ok({ subdomain: this.subdomain });
    }
    throw new Error(`FakeCloudflare: unhandled route ${method} ${path}`);
  }
}

/** A recorded wrangler invocation. */
export interface ExecCall {
  command: string;
  args: string[];
  options: ExecOptions;
}

/** Fake wrangler: records calls and answers with per-subcommand handlers. */
export function fakeExec(
  handler: (call: ExecCall) => { code?: number; stdout?: string; stderr?: string } = () => ({}),
): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const r = handler(call);
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}

/**
 * Make any use of the real global `fetch` fail the test. Commands must use the injected fake.
 */
export function forbidRealNetwork(): void {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (input: unknown) => {
      throw new Error(`Real network access attempted in a test: ${String(input)}`);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
