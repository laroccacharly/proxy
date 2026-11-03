import { ApiKeyAuth, CurrentApiKey } from "api-key-auth"
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient, HttpServerError, type HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Credentials from "effect-lib/credentials"
import * as Push from "effect-lib/push"
import { ProxyApi, ProxyError, RateLimited, RateLimitGuard } from "../api.ts"

// Refuses the call when `isWithinRateLimit` is false, before it reaches the handler.
export const rateLimitGuard = (isWithinRateLimit: Effect.Effect<boolean>) =>
  Layer.succeed(
    RateLimitGuard,
    RateLimitGuard.of(
      Effect.fnUntraced(function* rateLimitGuard(httpEffect) {
        if (!(yield* isWithinRateLimit)) {
          return yield* new RateLimited({ message: "over the proxy's rate limit, retry in a minute" })
        }
        return yield* httpEffect
      })
    )
  )

// The admin routes, the Bearer middleware and its scopes; keys look like pxy_<43 characters>.
const apiKeyAuth = ApiKeyAuth.layer(ProxyApi, { adminKey: Config.Redacted("PROXY_ADMIN_API_KEY"), prefix: "pxy_", scopes: ["push", "images"] })

const healthHandlers = HttpApiBuilder.group(ProxyApi, "health", (handlers) => handlers.handle("check", () => Effect.succeed({ status: "ok" as const })))

// An upstream's failure, or its credentials missing from the Worker's env, as the proxy's error.
const toProxyError = (error: { readonly message: string }) => new ProxyError({ message: error.message })

// Who called what, never what they sent.
const logCall = (endpoint: string) => Effect.flatMap(Effect.service(CurrentApiKey), (key) => Effect.logInfo(`${endpoint} by ${key.name} (${key.id})`))

const pushHandlers = HttpApiBuilder.group(ProxyApi, "push", (handlers) =>
  Effect.gen(function* pushHandlers() {
    const push = yield* Push.Push
    return handlers
      .handle("check", () => Effect.service(CurrentApiKey))
      .handle("notify", ({ payload }) =>
        logCall("POST /api/push").pipe(Effect.andThen(push.notify(payload.message, { title: payload.title })), Effect.mapError(toProxyError))
      )
  })
)

// The upstreams, with their credentials from the Worker's env only; PUSH_ORIGIN points Push elsewhere, as tests do.
const upstreams = Layer.unwrap(
  Effect.gen(function* upstreams() {
    const pushOrigin = yield* Config.String("PUSH_ORIGIN").pipe(Config.withDefault(Push.ORIGIN))
    return Push.layer({ origin: pushOrigin })
  })
).pipe(Layer.provide([Credentials.envOnlyLayer, FetchHttpClient.layer]))

// ProxyApi's routes; needs the database's SqlClient, the RateLimitGuard, and PROXY_ADMIN_API_KEY and the upstreams'
// credentials in the Config.
export const routes = HttpApiBuilder.layer(ProxyApi).pipe(Layer.provide([healthHandlers, pushHandlers]), Layer.provide([apiKeyAuth, upstreams]))

// Failures the API doesn't encode itself, such as an unknown route, as responses.
export const respondToFailures = <E, R>(handle: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.catchCause(handle, (cause) => Effect.map(HttpServerError.causeResponse(cause), ([response]) => response))
