import { Duration, Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { RateLimiter } from "effect/persistence"
import { OpenAIImage } from "effect-lib/openai-image"
import { Api, ProxyError, RateLimited } from "../api.ts"

const toProxyError = (error: { readonly message: string }) => new ProxyError({ message: error.message })

const toRateLimited = ({ reason }: RateLimiter.RateLimiterError) => {
  if (reason._tag === "RateLimitStoreError") {
    return toProxyError(reason)
  }
  return new RateLimited({ message: `rate limit of ${reason.limit} per hour exceeded, retry in ${Math.ceil(Duration.toSeconds(reason.retryAfter))}s` })
}

export const healthHandlers = HttpApiBuilder.group(Api, "health", (handlers) => handlers.handle("check", () => Effect.succeed({ status: "ok" as const })))

// A token bucket: bursts up to imagesPerHour, then one more image every hour / imagesPerHour.
export const imagesHandlers = (imagesPerHour: number) =>
  HttpApiBuilder.group(Api, "images", (handlers) =>
    Effect.gen(function* () {
      const images = yield* OpenAIImage
      const limiter = yield* RateLimiter.RateLimiter
      const consume = limiter.consume({ key: "images", limit: imagesPerHour, window: "1 hour", algorithm: "token-bucket" }).pipe(Effect.mapError(toRateLimited))
      return handlers.handle("generate", ({ payload }) =>
        consume.pipe(Effect.andThen(images.generate(payload.prompt, payload.options).pipe(Effect.mapError(toProxyError))))
      )
    })
  )
