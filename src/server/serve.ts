import { BunHttpServer } from "@effect/platform-bun"
import { Layer } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as OpenAIImage from "effect-lib/openai-image"
import { Api } from "../api.ts"
import type { Config } from "../config.ts"
import { keyringLayer } from "./credentials.ts"
import { healthHandlers, imagesHandlers } from "./handlers.ts"

const upstreamsLayer = (config: Config) =>
  OpenAIImage.layer({ origin: config.openaiOrigin ?? OpenAIImage.ORIGIN }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(keyringLayer))

// Listens on 127.0.0.1 only; tailscale serve exposes it to the tailnet.
// No idle timeout: Bun's default 10 seconds would cut off an image that takes longer to generate.
export const serverLayer = (port: number, config: Config) =>
  HttpRouter.serve(HttpApiBuilder.layer(Api)).pipe(
    Layer.provide([healthHandlers, imagesHandlers]),
    Layer.provide(upstreamsLayer(config)),
    Layer.provide(BunHttpServer.layer({ port, hostname: "127.0.0.1", idleTimeout: 0 }))
  )
