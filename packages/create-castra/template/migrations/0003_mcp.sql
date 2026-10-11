-- Remote MCP: scoped tokens and the audit log (ADRs 0061, 0063). Internal `_castra_*` tables are
-- never exposed through REST or MCP.
--
-- Rollback (D1 migrations are forward-only; run manually if needed):
--   DROP INDEX IF EXISTS idx_castra_audit_token_id;
--   DROP INDEX IF EXISTS idx_castra_audit_at;
--   DROP TABLE IF EXISTS _castra_audit;
--   DROP INDEX IF EXISTS idx_castra_mcp_tokens_user_id;
--   DROP TABLE IF EXISTS _castra_mcp_tokens;
PRAGMA foreign_keys = ON;

CREATE TABLE _castra_mcp_tokens (
  id TEXT PRIMARY KEY NOT NULL, -- public lookup id, embedded in the token
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  name TEXT,
  token_hash TEXT NOT NULL UNIQUE, -- lowercase hex SHA-256 of the full token; the token is never stored
  scopes TEXT NOT NULL, -- space-separated: schema:read access:check data:read data:read:any_user
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_castra_mcp_tokens_user_id ON _castra_mcp_tokens (user_id);

-- No foreign keys: audit rows outlive revoked tokens and deleted users.
CREATE TABLE _castra_audit (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  token_id TEXT,
  user_id TEXT,
  tool TEXT, -- tool name for tools/call, else the JSON-RPC method; NULL when the request was not read
  arguments TEXT, -- JSON, at most 4096 characters
  outcome TEXT NOT NULL, -- ok | error | denied | invalid | rejected | unauthorized:<reason>
  status INTEGER NOT NULL
);
CREATE INDEX idx_castra_audit_at ON _castra_audit (at);
CREATE INDEX idx_castra_audit_token_id ON _castra_audit (token_id);
