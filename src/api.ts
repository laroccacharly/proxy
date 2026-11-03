import { ApiKeyAuth, ApiKeyRoutes, CallingApiKey } from "api-key-auth"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema } from "effect/http-api"

// Any failure behind the proxy: a missing api key, an upstream error, or the server being unreachable.
export class ProxyError extends Schema.TaggedError<ProxyError>()("ProxyError", { message: Schema.String }, { httpApiStatus: 502 }) {}

// The server refused the request to cap spending on the upstream api.
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", { message: Schema.String }, { httpApiStatus: 429 }) {}

// Mirrors ImageOptions from effect-lib/openai-image.
export const ImageOptions = Schema.Struct({
  aspect: Schema.optionalKey(Schema.Literals(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"])),
  size: Schema.optionalKey(Schema.TemplateLiteral([Schema.Int, "x", Schema.Int])),
  quality: Schema.optionalKey(Schema.Literals(["auto", "low", "medium", "high"])),
  transparent: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.String),
})

export type ImageOptions = typeof ImageOptions.Type

const Png = Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "image/png" }))

export const HealthGroup = HttpApiGroup.make("health").add(HttpApiEndpoint.get("check", "/health", { success: Schema.Struct({ status: Schema.Literal("ok") }) }))

export const ImagesGroup = HttpApiGroup.make("images").add(
  HttpApiEndpoint.post("generate", "/images/generate", {
    payload: Schema.Struct({ prompt: Schema.String, options: ImageOptions }),
    success: Png,
    error: [ProxyError, RateLimited],
  })
)

// The Pi server's API, until phase 6 of docs/migration.md removes it.
export const Api = HttpApi.make("proxy").add(HealthGroup).add(ImagesGroup)

// Refuses a call over the Worker's global rate limit, shared by every consumer.
export class RateLimitGuard extends HttpApiMiddleware.Service<RateLimitGuard>()("proxy/RateLimitGuard", { error: RateLimited }) {}

// Needs a key with the push scope. A middleware added later wraps the earlier ones, so Bearer runs before the rate
// limit and a call without a valid key spends none of it.
export class PushRoutes extends HttpApiGroup.make("push")
  .add(HttpApiEndpoint.get("check", "/api/push", { success: CallingApiKey }))
  .middleware(RateLimitGuard)
  .middleware(ApiKeyAuth.Bearer)
  .annotate(ApiKeyAuth.Scope, "push") {}

// The Worker's API: /health with no key, the admin key routes, then one set of routes per upstream api.
export class ProxyApi extends HttpApi.make("proxy").add(HealthGroup).add(ApiKeyRoutes).add(PushRoutes) {}
