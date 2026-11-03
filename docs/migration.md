# Migration: from a Pi on the tailnet to a Cloudflare Worker

## Goal

The proxy moves from a Raspberry Pi, reached over Tailscale, to a Cloudflare Worker. Being on the tailnet is no longer
the auth: the Worker issues API keys, and every consumer sends one. The Worker still holds the upstream keys and exposes
typed APIs, one per upstream. Pushover is the first, through effect-lib's `push`. OpenAI images follows.

Plain HTTP request and response, no streaming, as before.

## Decisions

- **Replace, not alongside.** The Worker becomes the only proxy. The Pi server, its systemd service, its Tailscale
  wiring and its keyring login go away (phase 6). Same repo, on `main`. Consumers keep importing `proxy/client`.
- **Names.** Every variable has the `PROXY_` prefix, like `FOOD_*` and `BENCH_*`:

  | Name                  | Who holds it                    | What it is                                                             |
  | --------------------- | ------------------------------- | ---------------------------------------------------------------------- |
  | `PROXY_URL`           | deployer, consumers             | Where the Worker is reached, e.g. `https://proxy.example.com`          |
  | `PROXY_ADMIN_API_KEY` | Worker secret, deployer         | Creates, lists and revokes consumer keys. Calls no upstream API        |
  | `PROXY_API_KEY`       | consumers                       | One per consumer, issued by the Worker. Calls the upstream APIs only   |
  | `PUSH_APP_TOKEN`      | Worker secret                   | Pushover application token, effect-lib's existing secret               |
  | `PUSH_USER_KEY`       | Worker secret                   | Pushover user key, effect-lib's existing secret                        |

  Each is an effect-lib `Credentials.secret`, read from the environment first, then the OS keyring. Keyring entries
  are shared across apps, so `PUSH_APP_TOKEN` stored once serves both the proxy's deploy and any other app.
- **Two key kinds, never interchangeable.** `PROXY_ADMIN_API_KEY` only reaches the `/api/keys` endpoints.
  `PROXY_API_KEY` only reaches the upstream endpoints. Either one on the wrong endpoint gets 401.
- **Consumer keys in D1, hashed, with api-key-auth.** The keys, their table, the admin routes, the bearer check and
  the `proxy keys` command come from `github:laroccacharly/api-key-auth`, shared with bench: a random key shown once at
  creation, only its SHA-256 stored. One key per consumer (a machine, an agent), so one can be revoked without
  touching the others.
- **Scopes per key.** A key lists the APIs it may call, e.g. `["push"]` or `["push", "images"]`. Calling another API
  gets 403. This keeps the old design where each key is bound to a specific API.
- **The server picks the Pushover recipient.** The client sends `message` and `title` only. A leaked `PROXY_API_KEY`
  can only notify the owner.
- **Credentials from the environment, through effect-lib unchanged.** `Push.layer` needs a `Keyring`, but
  `secret.resolve` already reads Effect's `Config` (the Worker's env) before the keyring. The Worker provides a
  `Keyring` layer that holds nothing, so every secret comes from the env. See phase 1.
- **Domain from `PROXY_URL`, as in food and cmail.** A host other than `*.workers.dev` or `localhost` becomes the
  Worker's custom domain. None under `alchemy dev`.
- **Global rate limit, as in bench.** One `Cloudflare.RateLimit` binding with a constant key, so every consumer
  shares one budget, which bounds the upstream cost. `DISABLE_RATE_LIMITER=true` under `alchemy dev` only. Over
  the limit: 429 `RateLimited`. Per-key limits can come later.
- **Deploy with alchemy through effect-lib's `Deploy.run`.** `bun run deploy login | plan | destroy | auth status`, and
  `bun run deploy` itself. Every
  resource gets an explicit name, and alchemy carries bench's patch that rejects unnamed ones, so
  `alchemy deploy --adopt` finds them all.
- **No logging of contents.** Requests are logged with method, path and key name, never a message or a prompt.

## Phase 0: upgrade

- `effect`, `@effect/platform-bun` and the new `@effect/sql-d1` at `4.1.2`, the latest.
- `effect-lib` at `v0.22.0`: `bun remove effect-lib && bun add github:laroccacharly/effect-lib#v0.22.0`.
- `alchemy` and `@alchemy.run/cloudflare` at `2.0.0-beta.85`, with bench's `patches/alchemy@2.0.0-beta.85.patch`
  (explicit names) as a `patchedDependencies` entry. `@cloudflare/workers-types` for the `RateLimit` type.
  `@effect/platform-node` at `4.1.2`, an optional peer that `alchemy dev` imports (bench gets it through foldkit).
- `@effect/sql-sqlite-bun` at `4.1.2` for the in-memory tests, and the latest `ts-lint`.
- `bun run typecheck`, `bun run lint`, and `bun test` pass before going on.

## Phase 1: an env-only Keyring in effect-lib

`Credentials.memoryKeyring()` already works as a Keyring that holds nothing. A named layer says what it is for:

```ts
// effect-lib/src/credentials/keyring.ts
// For runtimes without an OS keyring, like a Worker: every secret comes from the environment (Effect's Config),
// and login fails instead of storing.
export const envOnlyLayer: Layer.Layer<Keyring> = layer({
  get: () => Effect.succeedNone,
  set: (name) => Effect.fail(new CredentialsError({ name, reason: "keyring", message: `no keyring here: set ${name} in the environment` })),
  remove: () => Effect.succeed(false),
})
```

On the Worker: `Push.layer({ origin }).pipe(Layer.provide([Credentials.envOnlyLayer, FetchHttpClient.layer]))`. The
same goes for `OpenAIImage` in phase 5. Release it as effect-lib `v0.23.0` and bump the proxy to it.

`secret.resolve` must not touch `Bun.secrets` when the env has the value. It already doesn't. A test in effect-lib
confirms that `Push` resolves both tokens from a `ConfigProvider.fromUnknown` with `envOnlyLayer`.

## Phase 2: the Worker, D1 and consumer keys

Keys come from api-key-auth (`bun add github:laroccacharly/api-key-auth#v0.2.0`). Its design is `api-key-auth.md` in
its repo. Layout, following bench and food:

```
alchemy.run.ts                 Stack "proxy": the Worker, returns its url
migrations/                    written by `proxy keys migrations new ./migrations`
src/api.ts                     ProxyApi: health, ApiKeyRoutes (admin), push; later images
src/credentials.ts             ProxyUrl, ProxyApiKey, ProxyAdminApiKey secrets
src/worker/index.ts            Cloudflare.Worker "Worker": D1, RateLimit, env, domain from PROXY_URL
src/worker/http.ts             the rate limit, the handlers and api-key-auth's layer
src/deploy/deploy.ts           Deploy.run
src/client/index.ts            ProxyClient
src/cli/                       proxy keys, proxy login
```

Resources, each named explicitly:

- Worker `proxy`
- D1 database `proxy`, migrations from `./migrations`
- RateLimit `API`, own `namespaceId`, e.g. `simple: { limit: 30, period: 60 }`

Table: the library's `api_key_auth_keys`, created by the files `proxy keys migrations new ./migrations` writes,
`0001_api_key_auth_v1.sql` and `0002_api_key_auth_v2.sql`, which alchemy applies on deploy. Never edit them. Upgrading
the library: bump it, run `proxy keys migrations new ./migrations` again, deploy. A test runs
`proxy keys migrations check ./migrations`.

Keys look like `pxy_<32 random bytes, base64url>`. A name is a label and needn't be unique, so a key is revoked by its
id. A revoked key stays in the table, so `list` shows it.

```ts
ApiKeyAuth.layer(ProxyApi, { adminKey: Config.Redacted("PROXY_ADMIN_API_KEY"), prefix: "pxy_", scopes: ["push", "images"] })
```

Admin endpoints, the library's `ApiKeyRoutes`, behind its `Admin` middleware (bearer `PROXY_ADMIN_API_KEY`, compared
in constant time):

- `POST   /api/keys`      `{ name, scopes }` → `{ id, name, email, scopes, created_at, key }`, the key shown once
- `GET    /api/keys`      → every key, revoked ones included, without their hash
- `DELETE /api/keys/:id`  revokes

Consumer endpoints, in sets of routes behind the library's `Bearer` (bearer `PROXY_API_KEY`, looked up by hash, not
revoked), each set annotated with its scope, `.annotate(ApiKeyAuth.Scope, "push")`. `Bearer` checks the scope,
sets `last_used_at` and provides `CurrentApiKey`. Then the rate limit, then the handler:

- `GET  /health` with no key
- `GET  /api/push`: the calling key, so a consumer can check that it may push
- `POST /api/push` (phase 3)

Errors are typed and keep the current names: `Unauthorized` 401, `Forbidden` 403, `UnknownScope` 400 and `NotFound`
404 from the library; `RateLimited` 429 and `ProxyError` 502 from the proxy.

The CLI gains the library's `keysCommand`, given `ProxyUrl` and `ProxyAdminApiKey` (phase 4).

## Phase 3: Pushover

```ts
HttpApiEndpoint.post("notify", "/api/push", {
  payload: Schema.Struct({ message: Schema.String, title: Schema.optionalKey(Schema.String) }),
  error: [ProxyError, RateLimited],
})
```

The handler calls effect-lib's `Push.notify(message, { title })`. `PushError` and `CredentialsError` become
`ProxyError`. `PUSH_ORIGIN` (optional, defaults to `api.pushover.net`) lets the tests point it at a fake Pushover.

## Phase 4: client, CLI and deploy

Client:

```ts
ProxyClient.layer()                     // PROXY_URL and PROXY_API_KEY, environment first, then the keyring
ProxyClient.layer({ url, apiKey })      // explicit, for tests
client.notify(message, { title })       // Effect<void, ProxyError | RateLimited | Unauthorized | Forbidden>
```

The json-store `url` setting is dropped. `PROXY_URL` replaces it. The Pi server's test went in phase 6.

CLI, with the admin commands reading `PROXY_URL` and `PROXY_ADMIN_API_KEY`:

- `proxy login` and `proxy auth login | logout | status`: stores `PROXY_URL` and `PROXY_API_KEY` on a consumer machine,
  with effect-lib's `Credentials.make(...).commands` unchanged
- `proxy keys create <name> --scope push [--scope images]`: prints the new `PROXY_API_KEY` once, plain on stdout,
  so it pipes into `cpass`
- `proxy keys list`: ids, names, scopes, last use, revoked ones marked
- `proxy keys revoke <id>`
- `proxy keys migrations new | check ./migrations`: the library's migration files

`proxy keys` is api-key-auth's `keysCommand({ api: ProxyApi, url: ProxyUrl, adminKey: ProxyAdminApiKey })`, added in
phase 2.

Deploy (`src/deploy/deploy.ts`, run as `bun run deploy`):

```ts
Deploy.run({ app: "proxy", secrets: [ProxyUrl, ProxyAdminApiKey, Push.AppToken, Push.UserKey] }, { version })
```

`bun run deploy login` stores those in the keyring once, with the Cloudflare ones every app shares
(`WORKER_CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). The Worker gets them as env bindings, with the secrets as
secret bindings.

## Phase 5: OpenAI images

Bring `/api/images/generate` over, with the `images` scope, `OPENAI_API_KEY` as a Worker secret and `OPENAI_ORIGIN` for
tests. It shares the global rate limit. If images need a tighter cap than pushes, give images a second RateLimit
binding of its own, still global. Image generation can take up to a minute. Waiting on fetch doesn't count against the
Worker's CPU time, but check it against the real API before deleting the Pi server.

Done as `ImagesRoutes` on `ProxyApi`, with `OpenAIImage.layer` behind `Credentials.envOnlyLayer` like `Push`, and
`OpenAIImage.ApiKey` added to the deploy's secrets. Images share the one global limit for now (30 a minute); the Pi's
30 an hour for images alone is gone with its in-memory `RateLimiter`.

## Phase 6: remove the Pi

- Delete `src/server/`, `src/cli/commands/{server,service,tailscale}.ts`, the json-store config and the
  in-memory `RateLimiter`.
- No uninstall: the Pi server was never installed, so there was no systemd service or Tailscale serve to remove.
- Rewrite `AGENTS.md` for the Worker design. Make the README requirements Bun and a Cloudflare account, and drop
  Tailscale and systemd. Dropped `docs/proxy-vs-agent-vault.png`, its `scripts/diagram.ts` and `@resvg/resvg-js`, since it showed the
  tailnet.

## Testing

As in bench: the e2e tests run the real Worker under `alchemy dev`, on its own stage and port, with a fresh local D1
for each run and `DISABLE_RATE_LIMITER=true`. They start a fake Pushover (a `Bun.serve` that keeps the messages it gets)
and set `PUSH_ORIGIN` to it, then:

- create a key with the test `PROXY_ADMIN_API_KEY`
- `ProxyClient.notify` with that `PROXY_API_KEY`: the fake Pushover got the message, the title, and the server's
  token and user key
- no key, a wrong key, a revoked key: 401
- `PROXY_API_KEY` on `/api/keys`, and `PROXY_ADMIN_API_KEY` on `/api/push`: 401
- a key without the `push` scope: 403
- the fake Pushover answering `status: 0`: `ProxyError` with its reasons

One rate limit test runs against the guard directly, with a stubbed `isWithinRateLimit` that refuses: 429
`RateLimited`. The binding is off under `alchemy dev`.

Phase 2 has no upstream to fake yet: its tests run the Worker's `HttpApi` in Bun over `@effect/sql-sqlite-bun` in
memory, with the tables from `./migrations`, and drive it with the typed client and `proxy keys`.

All tests must take under 20 seconds, `alchemy dev` startup included. If they don't, run the `HttpApi` in Bun over
`@effect/sql-sqlite-bun` instead, and keep `alchemy dev` for a single smoke test.

## Order and checkpoints

0. Upgrade: green tests on the old server.
1. effect-lib `envOnlyLayer`, released.
2. Worker, D1, keys: e2e tests for the key endpoints.
3. Pushover: the notify e2e test.
4. Client, CLI, deploy: first deploy, after asking. Then `proxy keys create` and a real notification to the phone.
5. Images on the Worker, checked against the real API.
6. Pi removed, docs rewritten.
