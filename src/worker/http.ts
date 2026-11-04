import { ApiKeyAuth, CurrentApiKey } from "api-key-auth"
import { Config, Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpServerError, type HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Credentials from "effect-lib/credentials"
import * as OpenAIImage from "effect-lib/openai-image"
import * as Push from "effect-lib/push"
import { LakeClient } from "lake-client"
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

const healthHandlers = HttpApiBuilder.group(ProxyApi, "health", (handlers) =>
  Effect.map(Config.String("DEPLOY_VERSION"), (version) => handlers.handle("check", () => Effect.succeed({ status: "ok" as const, version })))
)

// An upstream's failure, or its credentials missing from the Worker's env, as the proxy's error.
const toProxyError = (error: { readonly message: string }) => new ProxyError({ message: error.message })

// Who called what, never what they sent.
const logCall = (endpoint: string) => Effect.flatMap(Effect.service(CurrentApiKey), (key) => Effect.logInfo(`${endpoint} by ${key.name} (${key.id})`))

// Runs work after the response is sent, without delaying or failing it: the request's ctx.waitUntil on the Worker.
export class Background extends Context.Service<Background, { readonly run: (effect: Effect.Effect<void>) => Effect.Effect<void> }>()("proxy/Background") {}

// The push as a push.sent event in Lake, with LAKE_URL and PROXY_LAKE_API_KEY. Lake failing, or missing from the Config, is
// only logged, by its tag: its message could quote the push.
const recordPushSent = (keyName: string, payload: { readonly message: string; readonly title?: string }) =>
  Effect.gen(function* recordPushSent() {
    const url = yield* Config.String("LAKE_URL")
    const apiKey = yield* Config.Redacted("PROXY_LAKE_API_KEY")
    yield* LakeClient.use((lake) => lake.record({ source: "proxy", type: "push.sent", occurred_at: Date.now(), subject: keyName, data: { ...payload } })).pipe(
      Effect.provide(LakeClient.layer({ url, apiKey }))
    )
  }).pipe(Effect.catch((error) => Effect.logWarning(`POST /api/push by ${keyName}: not recorded in Lake, ${error._tag}`)))

const pushHandlers = HttpApiBuilder.group(ProxyApi, "push", (handlers) =>
  Effect.gen(function* pushHandlers() {
    const push = yield* Push.Push
    const background = yield* Background
    return handlers
      .handle("check", () => Effect.service(CurrentApiKey))
      .handle("notify", ({ payload }) =>
        Effect.gen(function* notify() {
          yield* logCall("POST /api/push")
          yield* push.notify(payload.message, { title: payload.title }).pipe(Effect.mapError(toProxyError))
          const key = yield* CurrentApiKey
          yield* background.run(recordPushSent(key.name, payload))
        })
      )
  })
)

const imagesHandlers = HttpApiBuilder.group(ProxyApi, "images", (handlers) =>
  Effect.gen(function* imagesHandlers() {
    const images = yield* OpenAIImage.OpenAIImage
    return handlers.handle("generate", ({ payload }) =>
      logCall("POST /api/images/generate").pipe(Effect.andThen(images.generate(payload.prompt, payload.options)), Effect.mapError(toProxyError))
    )
  })
)

// The upstreams, with their credentials from the Worker's env only; PUSH_ORIGIN and OPENAI_ORIGIN point them
// elsewhere, as tests do.
const upstreams = Layer.unwrap(
  Effect.gen(function* upstreams() {
    const pushOrigin = yield* Config.String("PUSH_ORIGIN").pipe(Config.withDefault(Push.ORIGIN))
    const openaiOrigin = yield* Config.String("OPENAI_ORIGIN").pipe(Config.withDefault(OpenAIImage.ORIGIN))
    return Layer.mergeAll(Push.layer({ origin: pushOrigin }), OpenAIImage.layer({ origin: openaiOrigin }))
  })
).pipe(Layer.provide([Credentials.envOnlyLayer, FetchHttpClient.layer]))

// ProxyApi's routes; needs the database's SqlClient, the RateLimitGuard, the Background, and PROXY_ADMIN_API_KEY,
// DEPLOY_VERSION, the upstreams' credentials and Lake's in the Config.
export const routes = HttpApiBuilder.layer(ProxyApi).pipe(Layer.provide([healthHandlers, pushHandlers, imagesHandlers]), Layer.provide([apiKeyAuth, upstreams]))

// Failures the API doesn't encode itself, such as an unknown route, as responses.
export const respondToFailures = <E, R>(handle: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.catchCause(handle, (cause) => Effect.map(HttpServerError.causeResponse(cause), ([response]) => response))
