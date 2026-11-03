import { ApiKeyAuth, Forbidden, Unauthorized } from "api-key-auth"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import * as Credentials from "effect-lib/credentials"
import { ImageOptions, ProxyApi, ProxyError, RateLimited } from "../api.ts"
import { ProxyApiKey, ProxyUrl } from "../credentials.ts"

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
  // With no options, PROXY_URL and PROXY_API_KEY: the environment first, then the OS keyring (`proxy login`).
  static readonly layer = (options?: ProxyClientOptions): Layer.Layer<ProxyClient, ProxyError> =>
    Layer.effect(ProxyClient, Effect.flatMap(resolveOptions(Option.fromUndefinedOr(options)), make)).pipe(Layer.provide(FetchHttpClient.layer))
}

export interface ProxyClientOptions {
  // The Worker's origin, e.g. https://proxy.example.com.
  readonly url: string
  // A consumer key from `proxy keys create`.
  readonly apiKey: string | Redacted.Redacted<string>
}

const toProxyError = (error: { readonly message: string }) => new ProxyError({ message: error.message })

const failWithProxyError = (error: { readonly message: string }) => Effect.fail(toProxyError(error))

const fromCredentials = Effect.gen(function* fromCredentials() {
  const url = yield* ProxyUrl.resolve
  const apiKey = yield* ProxyApiKey.resolve
  return { url: Redacted.value(url), apiKey }
}).pipe(Effect.mapError(toProxyError), Effect.provide(Credentials.layer(Credentials.bunKeyring())))

const resolveOptions = (options: Option.Option<ProxyClientOptions>) =>
  Option.match(options, { onNone: () => fromCredentials, onSome: (explicit) => Effect.succeed<ProxyClientOptions>(explicit) })

const asRedacted = (apiKey: string | Redacted.Redacted<string>) => {
  if (Redacted.isRedacted(apiKey)) {
    return apiKey
  }
  return Redacted.make(apiKey)
}

export const make = Effect.fnUntraced(function* make(options: ProxyClientOptions) {
  const client = yield* HttpApiClient.make(ProxyApi, { baseUrl: options.url }).pipe(Effect.provide(ApiKeyAuth.layerClient(asRedacted(options.apiKey))))

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
