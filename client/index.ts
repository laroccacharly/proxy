import { ApiKeyAuth, Forbidden, Unauthorized } from "api-key-auth"
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { ImageOptions, ProxyApi, ProxyError, RateLimited } from "./api.ts"
import { builtInUrl } from "./url.ts"

export { Forbidden, ImageOptions, ProxyError, RateLimited, Unauthorized }

// What the Worker may refuse a call with, beside the upstream's own failure.
export type CallError = ProxyError | RateLimited | Unauthorized | Forbidden

export interface NotifyOptions {
  // Shown above the message; Pushover falls back to the application name.
  readonly title?: string
}

export class ProxyClient extends Context.Service<
  ProxyClient,
  {
    // Sends a notification to the owner's phone, through the Worker's Pushover credentials.
    readonly notify: (message: string, options?: NotifyOptions) => Effect.Effect<void, CallError>
    // A new PNG from the prompt, generated with the Worker's OpenAI key.
    readonly generateImage: (prompt: string, options?: ImageOptions) => Effect.Effect<Uint8Array, CallError>
  }
>()("proxy/ProxyClient") {
  // What the options leave out comes from the ConfigProvider (the environment in Bun, the env in a Worker): PROXY_API_KEY,
  // and PROXY_URL, else the URL built into the client.
  static readonly layer = (options?: ProxyClientOptions): Layer.Layer<ProxyClient, ProxyError> =>
    Layer.effect(ProxyClient, make(options)).pipe(Layer.provide(FetchHttpClient.layer))
}

export interface ProxyClientOptions {
  // The Worker's origin, e.g. https://proxy.example.com. Only to override the one the client was built for.
  readonly url?: string
  // A consumer key from `proxy keys create`.
  readonly apiKey?: string | Redacted.Redacted<string>
}

const toProxyError = (error: { readonly message: string }) => new ProxyError({ message: error.message })

const failWithProxyError = (error: { readonly message: string }) => Effect.fail(toProxyError(error))

const noUrl = new ProxyError({ message: "No proxy URL: this client was built without one; pass `url` or set PROXY_URL" })

// `url`, else PROXY_URL, else the built-in URL.
const resolveUrl = (url: Option.Option<string>) =>
  Option.match(url, {
    onNone: () =>
      Config.option(Config.String("PROXY_URL")).pipe(
        Effect.mapError(toProxyError),
        Effect.map(Option.orElse(() => builtInUrl)),
        Effect.flatMap(Option.match({ onNone: () => Effect.fail(noUrl), onSome: Effect.succeed }))
      ),
    onSome: Effect.succeed,
  })

// `apiKey`, else PROXY_API_KEY.
const resolveApiKey = (apiKey: Option.Option<string | Redacted.Redacted<string>>) =>
  Option.match(apiKey, {
    onNone: () => Config.Redacted("PROXY_API_KEY").pipe(Effect.mapError(toProxyError)),
    onSome: (explicit) => Effect.succeed(asRedacted(explicit)),
  })

const asRedacted = (apiKey: string | Redacted.Redacted<string>) => {
  if (Redacted.isRedacted(apiKey)) {
    return apiKey
  }
  return Redacted.make(apiKey)
}

export const make = Effect.fnUntraced(function* make(options: ProxyClientOptions = {}) {
  const baseUrl = yield* resolveUrl(Option.fromUndefinedOr(options.url))
  const apiKey = yield* resolveApiKey(Option.fromUndefinedOr(options.apiKey))
  const client = yield* HttpApiClient.make(ProxyApi, { baseUrl }).pipe(Effect.provide(ApiKeyAuth.layerClient(apiKey)))

  const notify = (message: string, notifyOptions: NotifyOptions = {}) =>
    client.push.notify({ payload: { message, ...notifyOptions } }).pipe(
      Effect.catchTags({ HttpClientError: failWithProxyError, SchemaError: failWithProxyError }),
      Effect.withSpan("ProxyClient.notify")
    )

  const generateImage = (prompt: string, imageOptions: ImageOptions = {}) =>
    client.images.generate({ payload: { prompt, options: imageOptions } }).pipe(
      Effect.catchTags({ HttpClientError: failWithProxyError, SchemaError: failWithProxyError }),
      Effect.withSpan("ProxyClient.generateImage")
    )

  return ProxyClient.of({ notify, generateImage })
})
