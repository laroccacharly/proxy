# proxy
A typed proxy on a Cloudflare Worker. The Worker holds the upstream api keys and sets them in the outgoing http
request; consumers never see one.

Consumers import the proxy client and call typed methods for specific apis.
Example: `client.notify(message, { title })`, `client.generateImage(prompt, options)`.
This means the Worker must implement the api specific plumbing, one set of routes per upstream.
Plain http request/response, no streaming.

docs/migration.md is the plan this design came from.

# Design
## Worker
alchemy.run.ts deploys the Worker `proxy`, the D1 database `proxy` (migrations from ./migrations) and the RateLimit
`API`, each named explicitly so `alchemy deploy --adopt` finds them. The domain comes from PROXY_URL.

## Auth
Keys from api-key-auth (node_modules/api-key-auth/api-key-auth.md), stored hashed in D1. Don't hand-roll any of it.
- PROXY_ADMIN_API_KEY: a Worker secret; only reaches /api/keys (create, list, revoke, delete).
- PROXY_API_KEY: one per consumer, `pxy_…`, issued by the Worker; only reaches the upstream routes.
- Each upstream's routes are behind `ApiKeyAuth.Bearer` with their scope (`push`, `images`); a missing scope is 403.
- One global rate limit, shared by every consumer, after the key check: 429 RateLimited.
- migrations/ is written by `proxy keys migrations new ./migrations`. Never edit those files.

## Upstreams
effect-lib's `push` and `openai-image`, with `Credentials.envOnlyLayer`: every upstream credential is a Worker secret
(PUSH_APP_TOKEN, PUSH_USER_KEY, OPENAI_API_KEY). PUSH_ORIGIN and OPENAI_ORIGIN point them at fakes in tests.
Upstream failures become `ProxyError`. Log method, path and key name, never a message or a prompt.

## Deploy
`bun run deploy` with effect-lib's `Deploy.run` (src/deploy/deploy.ts). `bun run deploy login` keeps the secrets in the
OS keyring. Ask before deploying.
The Worker's version is the commit it was deployed from: `git describe --always --dirty` (src/version.ts), set as
PROXY_VERSION on deploy and answered by /health. Nothing to bump.

## CLI
`proxy login | auth logout | auth status`: PROXY_URL and PROXY_API_KEY on a consumer machine.
`proxy keys create | list | revoke | delete | migrations`: api-key-auth's keysCommand, with PROXY_URL and PROXY_ADMIN_API_KEY.

## Client
`ProxyClient.layer()` reads PROXY_URL and PROXY_API_KEY, environment first, then the keyring;
`ProxyClient.layer({ url, apiKey })` for explicit use and tests.

# Testing
test/worker.test.ts runs the Worker's HttpApi in Bun over @effect/sql-sqlite-bun in memory, with the tables from
./migrations, behind a real port. Fake upstreams with `Bun.serve` (Pushover, OpenAI).
- create keys with the admin key, through the typed client and `proxy keys`
- call the upstreams through ProxyClient; assert what the fake api got, with the Worker's credentials
- the auth cases: no, wrong, revoked or admin key 401; missing scope 403; rate limit 429
`bun run test:live` (test/live/worker.live.ts, never run by `bun test`) tests the running Worker at PROXY_URL with
PROXY_ADMIN_API_KEY, from the environment or the keyring: /health has this checkout's version, the auth cases but the
rate limit, and one real push. Its keys are deleted at the end. Images are not tested live.
Before a deploy, smoke-test the real Worker under `alchemy dev`, in a temp directory symlinked to the project, with
DEV_PORT and the secrets set; stop it with SIGINT to its process group.
