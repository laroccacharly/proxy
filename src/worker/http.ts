import { ApiKeyAuth, CurrentApiKey } from "api-key-auth"
import { Config, Effect, Layer } from "effect"
import { HttpServerError, type HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { ProxyApi, RateLimited, RateLimitGuard } from "../api.ts"

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

const pushHandlers = HttpApiBuilder.group(ProxyApi, "push", (handlers) => handlers.handle("check", () => Effect.service(CurrentApiKey)))

// ProxyApi's routes; needs the database's SqlClient, the RateLimitGuard and PROXY_ADMIN_API_KEY in the Config.
export const routes = HttpApiBuilder.layer(ProxyApi).pipe(Layer.provide([healthHandlers, pushHandlers]), Layer.provide(apiKeyAuth))

// Failures the API doesn't encode itself, such as an unknown route, as responses.
export const respondToFailures = <E, R>(handle: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.catchCause(handle, (cause) => Effect.map(HttpServerError.causeResponse(cause), ([response]) => response))
