import { env } from "cloudflare:workers";
import type { QueryFn } from "../../src/schema/index.js";

/** Fixture schema covering the shapes introspection must handle. One statement per entry (D1 batch). */
export const FIXTURE_SQL: string[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY NOT NULL,
     email TEXT NOT NULL UNIQUE,
     name TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   )`,
  `CREATE TABLE posts (
     id INTEGER PRIMARY KEY,
     author_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     parent_id INTEGER REFERENCES posts,
     title VARCHAR(255) NOT NULL,
     score DOUBLE PRECISION DEFAULT 0.5,
     views BIGINT NOT NULL DEFAULT 0,
     price DECIMAL(10,2),
     cover BLOB,
     payload,
     status TEXT NOT NULL DEFAULT 'draft'
   )`,
  `CREATE INDEX idx_posts_author ON posts (author_id)`,
  `CREATE UNIQUE INDEX uq_posts_title_status ON posts (title, status)`,
  `CREATE INDEX idx_posts_published ON posts (status) WHERE status = 'published'`,
  `CREATE INDEX idx_posts_expr ON posts (lower(title))`,
  `CREATE TABLE post_tags (
     post_id INTEGER NOT NULL,
     tag TEXT NOT NULL,
     weight REAL,
     PRIMARY KEY (tag, post_id),
     FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE ON UPDATE SET NULL
   )`,
  `CREATE TABLE "weird ""name""" ("odd col" TEXT)`,
  `CREATE TABLE _castra_audit (id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL)`,
  `CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE VIEW post_titles AS SELECT id, title FROM posts`,
];

export async function applyFixture(): Promise<void> {
  await env.DB.batch(FIXTURE_SQL.map((sql) => env.DB.prepare(sql)));
}

/** QueryFn over the miniflare D1 binding. */
export const d1Query: QueryFn = async (sql, params = []) => {
  const { results } = await env.DB.prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>();
  return results;
};
