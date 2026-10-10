import { describe, expect, it } from "vitest";
import { CloudflareApi, CloudflareApiError } from "../src/cloudflare/api.js";
import { run } from "../src/run.js";
import { FAKE_TOKEN, FakeCloudflare, forbidRealNetwork } from "./fake-cloudflare.js";

forbidRealNetwork();

describe("CloudflareApi", () => {
  it("pages through list endpoints", async () => {
    const cf = new FakeCloudflare();
    for (let i = 0; i < 230; i++) cf.kv.push({ id: `ns${i}`, title: `t${i}` });
    const api = new CloudflareApi(FAKE_TOKEN, cf.fetch);
    expect(await api.listKv("acc1")).toHaveLength(230);
    expect(cf.calls.map((c) => c.path)).toEqual([
      "/accounts/acc1/storage/kv/namespaces?page=1&per_page=100",
      "/accounts/acc1/storage/kv/namespaces?page=2&per_page=100",
      "/accounts/acc1/storage/kv/namespaces?page=3&per_page=100",
    ]);
  });

  it("sends the token only as a bearer header", async () => {
    const seen: RequestInit[] = [];
    const api = new CloudflareApi(FAKE_TOKEN, async (_url, init) => {
      seen.push(init!);
      return Response.json({ success: true, result: { id: "t", status: "active" } });
    });
    await api.verifyToken();
    expect(new Headers(seen[0]!.headers).get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("falls back to the account-token verify endpoint", async () => {
    const cf = new FakeCloudflare();
    cf.tokenKind = "account";
    const api = new CloudflareApi(FAKE_TOKEN, cf.fetch);
    await expect(api.verifyToken()).rejects.toBeInstanceOf(CloudflareApiError);
    expect(await api.verifyToken("acc1")).toEqual({ id: "tok1", status: "active", kind: "account" });
  });

  it("turns non-JSON error pages into CloudflareApiError", async () => {
    const api = new CloudflareApi(FAKE_TOKEN, async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const e = await api.listAccounts().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudflareApiError);
    expect((e as CloudflareApiError).status).toBe(502);
    expect((e as CloudflareApiError).isAuthError).toBe(false);
  });

  it("returns null secrets for a Worker that does not exist", async () => {
    const cf = new FakeCloudflare();
    const api = new CloudflareApi(FAKE_TOKEN, cf.fetch);
    expect(await api.listWorkerSecretNames("acc1", "nope")).toBeNull();
    cf.secrets.set("w", ["A"]);
    expect(await api.listWorkerSecretNames("acc1", "w")).toEqual(["A"]);
  });

  it("the fake refuses any host other than api.cloudflare.com", async () => {
    const cf = new FakeCloudflare();
    await expect(cf.fetch("https://example.com/")).rejects.toThrow(/Unexpected network call/);
  });

  it("the global fetch is blocked in tests, so the default RunEnv cannot reach the network", async () => {
    const err: string[] = [];
    const code = await run(["provision"], {
      cwd: "/nonexistent-castra-dir",
      log: () => {},
      error: (l) => err.push(l),
      env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN },
    });
    expect(code).toBe(2); // config missing: fails before any request
    await expect(globalThis.fetch("https://api.cloudflare.com/client/v4/user/tokens/verify")).rejects.toThrow(
      /Real network access/,
    );
  });
});
