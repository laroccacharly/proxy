-- api-key-auth schema v1, written by `keys migrations new`. Don't edit it: a change is the next version.

CREATE TABLE api_key_auth_keys (
  id           TEXT PRIMARY KEY,
  key_hash     TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  email        TEXT,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
