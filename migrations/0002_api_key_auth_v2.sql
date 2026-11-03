-- api-key-auth schema v2, written by `keys migrations new`. Don't edit it: a change is the next version.

CREATE INDEX api_key_auth_keys_email ON api_key_auth_keys (email);
