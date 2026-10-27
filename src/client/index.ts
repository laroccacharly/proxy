import { BunFileSystem } from "@effect/platform-bun"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { Api, ImageOptions, ProxyError, RateLimited } from "../api.ts"
import { loadConfig } from "../config.ts"

export { ImageOptions, ProxyError, RateLimited }

export class ProxyClient extends Context.Service<
  ProxyClient,
  {
    // A new PNG from the prompt, generated with the server's OpenAI key.
    readonly generateImage: (prompt: string, options?: ImageOptions) => Effect.Effect<Uint8Array, ProxyError | RateLimited>
  }
>()("proxy/ProxyClient") {
  static readonly layer = (options: ProxyClientOptions = {}): Layer.Layer<ProxyClient, ProxyError> => Layer.effect(ProxyClient, make(options)).pipe(Layer.provide(FetchHttpClient.layer))
}

export interface ProxyClientOptions {
  // The server's URL; defaults to `url` in the proxy config.
  readonly url?: string
}

const toProxyError = (error: { readonly message: string }) => new ProxyError({ message: error.message })

const failWithProxyError = (error: { readonly message: string }) => Effect.fail(toProxyError(error))

const resolveUrl = Effect.fnUntraced(function* resolveUrl(options: ProxyClientOptions) {
  if (options.url !== undefined) {
    return options.url
  }
  const config = yield* loadConfig.pipe(Effect.mapError(toProxyError), Effect.provide(BunFileSystem.layer))
  if (config.url === undefined) {
    return yield* new ProxyError({ message: "no proxy server url: run `proxy config set url <url>`" })
  }
  return config.url
})

export const make = Effect.fnUntraced(function* make(options: ProxyClientOptions = {}) {
  const client = yield* HttpApiClient.make(Api, { baseUrl: yield* resolveUrl(options) })

  const generateImage = (prompt: string, imageOptions: ImageOptions = {}) =>
    client.images.generate({ payload: { prompt, options: imageOptions } }).pipe(
      Effect.catchTags({ HttpClientError: failWithProxyError, SchemaError: failWithProxyError }),
      Effect.withSpan("ProxyClient.generateImage")
    )

  return ProxyClient.of({ generateImage })
})
