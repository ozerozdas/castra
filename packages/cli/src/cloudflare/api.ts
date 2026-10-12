/** Base URL of the Cloudflare REST API v4. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** The `fetch` signature the CLI depends on. Injected so tests never reach the network. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** One entry of a Cloudflare API `errors` array. */
export interface CloudflareMessage {
  code: number;
  message: string;
}

/** A non-success Cloudflare API response. `status` is the HTTP status. */
export class CloudflareApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly errors: CloudflareMessage[],
  ) {
    const detail = errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${status}`;
    super(`Cloudflare API ${method} ${path} failed (${status}): ${detail}`);
  }

  /** 401/403, or Cloudflare's "Authentication error" (10000) / "Invalid API Token" (1000). */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403 || this.errors.some((e) => e.code === 10000 || e.code === 1000);
  }

  /** HTTP 404, used by find-style lookups. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** Result of `GET /user/tokens/verify` or `GET /accounts/{id}/tokens/verify`. */
export interface TokenVerification {
  id: string;
  status: "active" | "disabled" | "expired" | string;
  /** Which endpoint accepted the token. */
  kind: "user" | "account";
}

export interface Account {
  id: string;
  name: string;
}

export interface D1Database {
  uuid: string;
  name: string;
}

export interface KvNamespace {
  id: string;
  title: string;
}

export interface R2Bucket {
  name: string;
}

export interface TokenPolicy {
  effect: "allow" | "deny" | string;
  /**
   * Resource keys the policy applies to, e.g. `{ "com.cloudflare.api.account.<id>": "*" }`; a value may be a
   * nested object selecting zones inside an account.
   */
  resources?: Record<string, unknown>;
  permission_groups: { id: string; name?: string }[];
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: CloudflareMessage[];
  result_info?: { page?: number; per_page?: number; total_pages?: number; total_count?: number; count?: number; cursor?: string };
}

/**
 * Minimal typed client for the Cloudflare endpoints Castra needs. Every call goes through the injected
 * `fetch`; nothing here shells out or reads the environment.
 *
 * Endpoints (verified against developers.cloudflare.com/api on 2026-10-10, see docs/cloudflare-token.md).
 */
export class CloudflareApi {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn,
    private readonly base: string = CLOUDFLARE_API_BASE,
  ) {}

  /** Perform a request and unwrap the `{ success, result }` envelope. */
  async request<T>(method: string, path: string, body?: unknown): Promise<{ result: T; info: Envelope<T>["result_info"] }> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: Partial<Envelope<T>> = {};
    try {
      json = (await res.json()) as Partial<Envelope<T>>;
    } catch {
      // Non-JSON body (e.g. an HTML error page): fall through with an empty envelope.
    }
    if (!res.ok || json.success === false) {
      throw new CloudflareApiError(method, path, res.status, json.errors ?? []);
    }
    return { result: json.result as T, info: json.result_info };
  }

  /**
   * Verify the token. Tries the user-token endpoint first and, when an account id is known, falls back to the
   * account-owned-token endpoint (account tokens are rejected by `/user/tokens/verify`).
   */
  async verifyToken(accountId?: string): Promise<TokenVerification> {
    try {
      const { result } = await this.request<{ id: string; status: string }>("GET", "/user/tokens/verify");
      return { id: result.id, status: result.status, kind: "user" };
    } catch (e) {
      if (!(e instanceof CloudflareApiError) || accountId === undefined) throw e;
      const { result } = await this.request<{ id: string; status: string }>(
        "GET",
        `/accounts/${accountId}/tokens/verify`,
      );
      return { id: result.id, status: result.status, kind: "account" };
    }
  }

  /** Read a token's policies. Needs "API Tokens Read", which most deploy tokens lack; callers must tolerate failure. */
  async getTokenPolicies(verification: TokenVerification, accountId: string): Promise<TokenPolicy[]> {
    const path =
      verification.kind === "user" ? `/user/tokens/${verification.id}` : `/accounts/${accountId}/tokens/${verification.id}`;
    const { result } = await this.request<{ policies?: TokenPolicy[] }>("GET", path);
    return result.policies ?? [];
  }

  async listAccounts(): Promise<Account[]> {
    return this.paged<Account>("/accounts", 50);
  }

  async listD1(accountId: string, name?: string): Promise<D1Database[]> {
    const query = name === undefined ? "" : `name=${encodeURIComponent(name)}`;
    return this.paged<D1Database>(`/accounts/${accountId}/d1/database`, 100, query);
  }

  /** A D1 database by id, or `null` when it does not exist. */
  async getD1(accountId: string, databaseId: string): Promise<D1Database | null> {
    try {
      return (await this.request<D1Database>("GET", `/accounts/${accountId}/d1/database/${encodeURIComponent(databaseId)}`)).result;
    } catch (e) {
      if (e instanceof CloudflareApiError && (e.isNotFound || e.errors.some((x) => x.code === 7404))) return null;
      throw e;
    }
  }

  async deleteD1(accountId: string, databaseId: string): Promise<void> {
    await this.request("DELETE", `/accounts/${accountId}/d1/database/${encodeURIComponent(databaseId)}`);
  }

  async createD1(accountId: string, name: string): Promise<D1Database> {
    return (await this.request<D1Database>("POST", `/accounts/${accountId}/d1/database`, { name })).result;
  }

  /** Run SQL against a remote D1 database (`POST .../d1/database/{id}/query`). Returns the first result set. */
  async queryD1(accountId: string, databaseId: string, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const { result } = await this.request<{ results?: Record<string, unknown>[] }[]>(
      "POST",
      `/accounts/${accountId}/d1/database/${databaseId}/query`,
      { sql, params: params.map((p) => (p === null ? null : String(p))) },
    );
    return result[0]?.results ?? [];
  }

  async listKv(accountId: string): Promise<KvNamespace[]> {
    return this.paged<KvNamespace>(`/accounts/${accountId}/storage/kv/namespaces`, 100);
  }

  async createKv(accountId: string, title: string): Promise<KvNamespace> {
    return (await this.request<KvNamespace>("POST", `/accounts/${accountId}/storage/kv/namespaces`, { title })).result;
  }

  async deleteKv(accountId: string, namespaceId: string): Promise<void> {
    await this.request("DELETE", `/accounts/${accountId}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}`);
  }

  /** Fails when the bucket still holds objects (Cloudflare refuses to delete a non-empty bucket). */
  async deleteR2(accountId: string, name: string): Promise<void> {
    await this.request("DELETE", `/accounts/${accountId}/r2/buckets/${encodeURIComponent(name)}`);
  }

  /** Deletes a Worker script, without `force`: Cloudflare refuses when another Worker references it. */
  async deleteWorker(accountId: string, scriptName: string): Promise<void> {
    await this.request("DELETE", `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`);
  }

  async listR2(accountId: string, nameContains?: string): Promise<R2Bucket[]> {
    const buckets: R2Bucket[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const params = new URLSearchParams({ per_page: "1000" });
      if (nameContains !== undefined) params.set("name_contains", nameContains);
      if (cursor !== undefined) params.set("cursor", cursor);
      const { result, info } = await this.request<{ buckets?: R2Bucket[] }>(
        "GET",
        `/accounts/${accountId}/r2/buckets?${params.toString()}`,
      );
      buckets.push(...(result.buckets ?? []));
      cursor = info?.cursor || undefined;
      if (cursor === undefined) break;
    }
    return buckets;
  }

  async createR2(accountId: string, name: string): Promise<R2Bucket> {
    return (await this.request<R2Bucket>("POST", `/accounts/${accountId}/r2/buckets`, { name })).result;
  }

  /** Names of the secrets bound to a Worker, or `null` when the Worker does not exist yet. */
  async listWorkerSecretNames(accountId: string, scriptName: string): Promise<string[] | null> {
    try {
      const { result } = await this.request<{ name: string }[]>(
        "GET",
        `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
      );
      return (result ?? []).map((s) => s.name);
    } catch (e) {
      if (e instanceof CloudflareApiError && (e.isNotFound || e.errors.some((x) => x.code === 10007))) return null;
      throw e;
    }
  }

  /** The account's `*.workers.dev` subdomain (without the suffix). */
  async getWorkersSubdomain(accountId: string): Promise<string> {
    return (await this.request<{ subdomain: string }>("GET", `/accounts/${accountId}/workers/subdomain`)).result.subdomain;
  }

  /** Page-numbered list endpoints. Stops when a page is short or `total_pages` is reached. */
  private async paged<T>(path: string, perPage: number, extraQuery = ""): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const query = `page=${page}&per_page=${perPage}${extraQuery ? `&${extraQuery}` : ""}`;
      const { result, info } = await this.request<T[]>("GET", `${path}?${query}`);
      const batch = Array.isArray(result) ? result : [];
      items.push(...batch);
      if (batch.length < perPage) break;
      if (info?.total_pages !== undefined && page >= info.total_pages) break;
    }
    return items;
  }
}
