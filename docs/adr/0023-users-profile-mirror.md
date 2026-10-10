# 0023. Mirror a public profile into the app `users` table

## Status
Accepted (2026-10-10).

## Context
Better Auth owns `user`, `session`, `account` and `verification`; Castra never exposes them
(ARCHITECTURE §3). Apps still need a user table they can reference with foreign keys and expose
through policies (the blog's `users`, referenced by `posts.author_id` and `comments.user_id`).

## Decision
- Better Auth `databaseHooks.user.create.after` upserts `(id, email, name)` into `users`;
  `user.update.after` updates the same columns. The user id is the same in both tables.
- The table name is the fixed identifier `users`; `mirrorUsers: false` turns the hooks off for apps
  without such a table.
- Only `id`, `email`, `name` are copied. Password hashes, tokens and provider data stay in Better
  Auth tables.

## Consequences
- D1 has no interactive transactions, so the mirror write is not atomic with the Better Auth insert.
  If it fails (for example an existing `users` row with the same email and a different id), the
  hook throws after the Better Auth user already exists, leaving a user without a mirror row. There
  is no automatic repair in v0.1; a repair/backfill command is future work.
- Deleting a Better Auth user does not delete the `users` row (app data may reference it).
  `_castra_roles` and `_castra_api_keys` rows cascade.
