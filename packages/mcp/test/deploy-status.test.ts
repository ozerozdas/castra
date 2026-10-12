import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createCastraMcpServer, localAccess, type DeployStatusFn } from "../src/index.js";
import { config, setup, testDb } from "./fixtures.js";

const noValidation = { getValidator: () => () => ({ valid: false as const, data: undefined, errorMessage: "unsupported" }) };

async function client(deployStatus?: DeployStatusFn) {
  const snapshot = await setup();
  const db = testDb();
  const server = createCastraMcpServer({ config, snapshot, db, access: localAccess(db, config), deployStatus });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const c = new Client({ name: "test", version: "0" }, { jsonSchemaValidator: noValidation });
  await c.connect(clientSide);
  return c;
}

describe("deploy_status (ADR 0079)", () => {
  it("is registered only when the host passes deployStatus (castra mcp), and forwards remote", async () => {
    expect((await (await client()).listTools()).tools.map((t) => t.name)).not.toContain("deploy_status");
    const seen: boolean[] = [];
    const c = await client(async ({ remote }) => (seen.push(remote), { ok: true, checks: [], drift: [] }));
    expect((await c.listTools()).tools.find((t) => t.name === "deploy_status")?.annotations?.readOnlyHint).toBe(true);
    const r = await c.callTool({ name: "deploy_status", arguments: { remote: true } });
    expect(r.structuredContent).toEqual({ ok: true, checks: [], drift: [] });
    await c.callTool({ name: "deploy_status", arguments: {} });
    expect(seen).toEqual([true, false]);
  });

  it("reports a failing check run as a tool error", async () => {
    const c = await client(async () => {
      throw new Error("boom");
    });
    const r = await c.callTool({ name: "deploy_status", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ detail: "boom" });
  });
});
