import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { OpenAIImage } from "effect-lib/openai-image"
import { Api, ProxyError } from "../api.ts"

const toProxyError = (error: { readonly message: string }) => new ProxyError({ message: error.message })

export const healthHandlers = HttpApiBuilder.group(Api, "health", (handlers) => handlers.handle("check", () => Effect.succeed({ status: "ok" as const })))

export const imagesHandlers = HttpApiBuilder.group(Api, "images", (handlers) =>
  Effect.gen(function* () {
    const images = yield* OpenAIImage
    return handlers.handle("generate", ({ payload }) => images.generate(payload.prompt, payload.options).pipe(Effect.mapError(toProxyError)))
  })
)
