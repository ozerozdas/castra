-- Auth + internal tables. Never exposed by Castra (no policy, reserved names).
--
-- Better Auth 1.7.7 tables below are generated, not hand-written:
--   pnpm --filter @castra-kit/auth build && pnpm --filter @castra-kit/auth auth:schema
-- Regenerate and diff on every Better Auth upgrade (ADR 0020).
PRAGMA foreign_keys = ON;

-- ---- Better Auth (generated) ----
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

-- ---- Castra internal ----

-- Role grants. Validated against the configured role list in application code.
CREATE TABLE _castra_roles (
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, role)
);

-- API keys (ADR 0022). Only the SHA-256 hash of the key is stored; `id` is the public part of the key.
CREATE TABLE _castra_api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  name TEXT,
  key_hash TEXT NOT NULL UNIQUE,
  roles TEXT, -- JSON array of role names; NULL = all of the user's roles
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_castra_api_keys_user_id ON _castra_api_keys (user_id);
