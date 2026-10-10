INSERT INTO users (id, email, name) VALUES
  ('00000000-0000-4000-8000-000000000001', 'alice@example.com', 'Alice'),
  ('00000000-0000-4000-8000-000000000002', 'bob@example.com', 'Bob');

INSERT INTO posts (id, author_id, title, body, status, internal_notes) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Hello world', 'First published post.', 'published', 'seed note'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Work in progress', 'A draft only Alice should see.', 'draft', 'needs editing'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'Bob writes', 'Published by Bob.', 'published', NULL);

INSERT INTO comments (id, post_id, user_id, body) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'Nice post!');

INSERT INTO audit_logs (id, action) VALUES
  ('30000000-0000-4000-8000-000000000001', 'seed');
