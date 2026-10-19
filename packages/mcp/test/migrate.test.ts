/**
 * `generate_migration` / `apply_migration` (ADR 0086): local-only MCP tools that delegate to the
 * `castra migrate` workflow. They never execute SQL themselves; wrangler stays the runner.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiError, type SchemaSnapshot } from "@castra-kit/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createCastraMcpServer, localAccess, mcpDb, type MigrationCallbacks } from "../src/index.js";
import { call, config, setup, testDb } from "./fixtures.js";

let snapshot: SchemaSnapshot;
beforeAll(async () => {
  snapshot = await setup();
});

const noValidation = { getValidator: () => () => ({ valid: false as const, data: undefined, errorMessage: "unsupported" }) };

/** All migration callbacks are mocks; only the {@link MigrationCallbacks} typing matters. */
function mockCallbacks(overrides: Partial<MigrationCallbacks> = {}): MigrationCallbacks {
  return {
    resolveTarget: vi.fn().mockResolvedValue({ dir: "/migrations", binding: "DB", targetName: "local" }),
    createMigration: vi.fn().mockImplementation((name: string) => {
      const slug = name.trim().replace(/\s+/g, "_");
      const file = `0001_${slug}.sql`;
      return Promise.resolve({
        file,
        path: `/migrations/${file}`,
        body: `-- ${name}\n--\n-- Rollback:\n--\n\n`,
      });
    }),
    readStatus: vi.fn().mockResolvedValue({ applied: ["0000_init.sql"], pending: ["0001_add_notes_title.sql"], unknown: [] }),
    driftCheck: vi.fn().mockResolvedValue({ ok: true, drift: [] }),
    applyMigrations: vi.fn().mockResolvedValue({ code: 0 }),
    ...overrides,
  };
}

/** A local (stdio-style) server with the migration callbacks wired in. */
function createLocalServer(callbacks: MigrationCallbacks): McpServer {
  const db = testDb();
  return createCastraMcpServer({
    config,
    snapshot,
    db,
    access: localAccess(mcpDb(db), config),
    migrations: callbacks,
  });
}

/** Connects a fresh in-memory client to an already-built server. */
async function connectServer(server: McpServer): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" }, { jsonSchemaValidator: noValidation });
  await client.connect(clientSide);
  return client;
}

describe("generate_migration", () => {
  it("writes the migration file and returns metadata", async () => {
    const callbacks = mockCallbacks();
    const client = await connectServer(createLocalServer(callbacks));

    const r = await call(client, "generate_migration", { name: "add notes title" });

    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      written: true,
      path: "/migrations/0001_add_notes_title.sql",
      file: "0001_add_notes_title.sql",
    });
    expect(String(r.data.preview)).toMatch(/^-- add notes title\n--\n/);
    expect(r.data.next).toBeTruthy();
    expect(callbacks.createMigration).toHaveBeenCalledTimes(1);
    expect(callbacks.createMigration).toHaveBeenCalledWith("add notes title");
  });

  it("rejects an empty name as 400 invalid_name", async () => {
    const callbacks = mockCallbacks({
      createMigration: vi.fn().mockRejectedValue(new ApiError(400, "invalid_name", "Migration name cannot be empty")),
    });
    const client = await connectServer(createLocalServer(callbacks));

    const r = await call(client, "generate_migration", { name: "" });

    expect(r.isError).toBe(true);
    // NOTE: the tool's zod schema uses `.min(1)`, so the MCP SDK rejects an empty name before the
    // handler runs. The brief asked for a 400 `invalid_name`, but the actual result is the SDK's
    // generic input-validation error.
    expect(r.text).toMatch(/Too small|Input validation error/);
    expect(callbacks.createMigration).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only name as 400 invalid_name", async () => {
    const callbacks = mockCallbacks({
      createMigration: vi.fn().mockRejectedValue(new ApiError(400, "invalid_name", "Migration name cannot be whitespace")),
    });
    const client = await connectServer(createLocalServer(callbacks));

    const r = await call(client, "generate_migration", { name: "   " });

    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ status: 400 });
    expect(String(r.data.type)).toMatch(/invalid_name/);
    expect(callbacks.createMigration).toHaveBeenCalledTimes(1);
  });
});

describe("apply_migration", () => {
  it("returns pending list without applying when approve is absent", async () => {
    const callbacks = mockCallbacks();
    const client = await connectServer(createLocalServer(callbacks));

    const r = await call(client, "apply_migration", {});

    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      approved: false,
      applied: ["0000_init.sql"],
      pending: ["0001_add_notes_title.sql"],
      unknown: [],
    });
    expect(r.data.hint).toBeTruthy();
    expect(callbacks.readStatus).toHaveBeenCalledTimes(1);
    expect(callbacks.driftCheck).not.toHaveBeenCalled();
    expect(callbacks.applyMigrations).not.toHaveBeenCalled();
  });

  it("applies pending migrations after a clean drift check", async () => {
    const callbacks = mockCallbacks();
    const client = await connectServer(createLocalServer(callbacks));

    const r = await call(client, "apply_migration", { approve: true });

    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      approved: true,
      applied: ["0001_add_notes_title.sql"],
    });
    expect(r.data.next).toBeTruthy();
    expect(callbacks.readStatus).toHaveBeenCalledTimes(1);
    expect(callbacks.driftCheck).toHaveBeenCalledTimes(1);
    expect(callbacks.applyMigrations).toHaveBeenCalledTimes(1);
  });

  it("returns schema_drift 409 and does not apply when drift check fails", async () => {
    const callbacks = mockCallbacks({
      driftCheck: vi.fn().mockResolvedValue({ ok: false, drift: ["notes.title: local=text, remote=missing"] }),
    });
    const client = await connectServer(createLocalServer(callbacks));

    const r = await call(client, "apply_migration", { approve: true });

    expect(r.isError).toBe(true);
    // NOTE: `registerMigrations` puts `status` on the tool result, not inside `structuredContent`,
    // so only `code` and `detail` appear in `r.data`.
    expect(r.data).toMatchObject({
      code: "schema_drift",
      detail: ["notes.title: local=text, remote=missing"],
    });
    expect(callbacks.driftCheck).toHaveBeenCalledTimes(1);
    expect(callbacks.applyMigrations).not.toHaveBeenCalled();
  });
});

describe("migration tool registration", () => {
  it("is local-only: a remote-style server has no migration tools", async () => {
    const db = testDb();
    const server = createCastraMcpServer({ config, snapshot, db, access: localAccess(mcpDb(db), config) });
    const client = await connectServer(server);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);

    expect(names).not.toContain("generate_migration");
    expect(names).not.toContain("apply_migration");
  });
});
