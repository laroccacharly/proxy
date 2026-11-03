import * as Cloudflare from "@alchemy.run/cloudflare"
import type { RateLimit } from "@cloudflare/workers-types"
import { D1Client } from "@effect/sql-d1"
import { ALCHEMY_DEV } from "alchemy"
import { Config, Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { rateLimitGuard, respondToFailures, routes } from "./http.ts"

// `true` skips the rate limit. Set only under `alchemy dev`.
const rateLimiterDisabled = Config.String("DISABLE_RATE_LIMITER").pipe(
  Config.map((value) => value === "true"),
  Config.withDefault(false)
)

// The variables only `alchemy dev` sets.
const devEnv = (isDev: boolean): Record<string, string> => {
  if (isDev) {
    return { DISABLE_RATE_LIMITER: "true" }
  }
  return {}
}

// The upstreams' secrets, from the environment, required under `alchemy dev` too. PUSH_ORIGIN is optional: the tests
// point it at a fake Pushover.
const secretsEnv = Effect.gen(function* secretsEnv() {
  const pushOrigin = yield* Config.option(Config.String("PUSH_ORIGIN"))
  return {
    PUSH_APP_TOKEN: yield* Config.Redacted("PUSH_APP_TOKEN"),
    PUSH_USER_KEY: yield* Config.Redacted("PUSH_USER_KEY"),
    ...Option.match(pushOrigin, { onNone: () => ({}), onSome: (origin) => ({ PUSH_ORIGIN: origin }) }),
  }
})

// Where the Worker is reached: PROXY_URL, required on deploy; under `alchemy dev`, the dev server.
const proxyUrlOf = (devPort: number) =>
  Effect.gen(function* proxyUrlOf() {
    if (yield* ALCHEMY_DEV) {
      return `http://localhost:${devPort}`
    }
    return yield* Config.String("PROXY_URL")
  })

// A host other than workers.dev, which Cloudflare serves without one, is attached as a custom domain.
const domainOf = (proxyUrl: string): { readonly domain?: string } => {
  const { hostname } = new URL(proxyUrl)
  if (hostname === "localhost" || hostname.endsWith(".workers.dev")) {
    return {}
  }
  return { domain: hostname }
}

// One constant key: every consumer shares the limit, which bounds the upstream cost.
const rateLimitCheck = (rateLimit: RateLimit, isDisabled: boolean) => {
  if (isDisabled) {
    return Effect.succeed(true)
  }
  return Effect.promise(() => rateLimit.limit({ key: "api" })).pipe(Effect.map((outcome) => outcome.success))
}

export default class Worker extends Cloudflare.Worker<Worker>()(
  "Worker",
  Effect.gen(function* workerProps() {
    const devPort = yield* Config.Int("DEV_PORT").pipe(Config.withDefault(1340))
    const proxyUrl = yield* proxyUrlOf(devPort)
    return {
      name: "proxy",
      main: import.meta.url,
      compatibility: {
        // Must not be newer than what Alchemy's bundled workerd supports.
        date: "2026-09-01",
      },
      // `alchemy dev` serves the Worker here. Strict, so a test can rely on the port.
      dev: {
        port: devPort,
        strictPort: true,
      },
      ...domainOf(proxyUrl),
      env: {
        ...devEnv(yield* ALCHEMY_DEV),
        ...(yield* secretsEnv),
        PROXY_ADMIN_API_KEY: yield* Config.Redacted("PROXY_ADMIN_API_KEY"),
        // The Worker reads its props again when it runs, so it needs the URL it was deployed for.
        PROXY_URL: proxyUrl,
      },
    }
  }),
  Effect.gen(function* worker() {
    const database = yield* Cloudflare.D1.Database("Proxy", { name: "proxy", migrations: "./migrations" })
    const db = yield* Cloudflare.D1.QueryDatabase(database)
    const limiter = yield* Cloudflare.RateLimit("API", { namespaceId: 2402, simple: { limit: 30, period: 60 } })
    // Built for each request: the bindings are only reachable inside one.
    const handleFetch = Effect.gen(function* handleFetch() {
      const sql = D1Client.layer({ db: yield* db.raw })
      const guard = rateLimitGuard(rateLimitCheck(yield* limiter.raw, yield* rateLimiterDisabled))
      const handle = yield* HttpRouter.toHttpEffect(routes.pipe(Layer.provide([guard, sql, HttpServer.layerServices])))
      return yield* respondToFailures(handle)
    })
    return { fetch: handleFetch.pipe(Effect.orDie) }
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.D1.QueryDatabaseBinding, Cloudflare.Workers.RateLimitBinding)))
) {}
