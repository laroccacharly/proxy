import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"

// Any failure behind the proxy: a missing api key, an upstream error, or the server being unreachable.
export class ProxyError extends Schema.TaggedError<ProxyError>()("ProxyError", { message: Schema.String }, { httpApiStatus: 502 }) {}

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
    error: ProxyError,
  })
)

export const Api = HttpApi.make("proxy").add(HealthGroup).add(ImagesGroup)
