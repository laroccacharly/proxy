// What test/worker.test.ts and test/live/worker.live.ts share: the typed client, the `proxy keys` command, and the
// outcome of a call, against a Worker at `url`.

import { join } from "node:path"
import { ApiKeyAuth } from "api-key-auth"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { ProxyApi } from "../client/api.ts"

export const projectRoot = join(import.meta.dir, "..")

// `proxy keys …` against the Worker at `url`, with `adminKey` from the environment.
export const runKeys = async (url: string, adminKey: string, args: ReadonlyArray<string>) => {
  const child = Bun.spawn(["bun", join(projectRoot, "src", "cli", "index.ts"), "keys", ...args], {
    env: { ...process.env, PROXY_URL: url, PROXY_ADMIN_API_KEY: adminKey },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout: stdout.trim(), stderr, exitCode }
}

// The typed client, sending `key` as a consumer or `admin` as the admin, or nothing.
export const clientOf = (url: string, credentials: { readonly key?: string; readonly admin?: string } = {}) => {
  const middlewares = []
  if (credentials.key !== undefined) {
    middlewares.push(ApiKeyAuth.layerClient(Redacted.make(credentials.key)))
  }
  if (credentials.admin !== undefined) {
    middlewares.push(ApiKeyAuth.layerAdminClient(Redacted.make(credentials.admin)))
  }
  return HttpApiClient.make(ProxyApi, { baseUrl: url }).pipe(Effect.provide(Layer.mergeAll(Layer.empty, ...middlewares)))
}

// `run` and `outcome`, sending the calls through `http`.
export const runnersOver = (http: Layer.Layer<HttpClient.HttpClient>) => {
  const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => Effect.runPromise(effect.pipe(Effect.provide(http)))

  // The tag of the error `effect` fails with, or `ok`.
  const outcome = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    run(effect.pipe(Effect.as("ok"), Effect.catch((error) => Effect.succeed(error._tag))))

  return { run, outcome }
}

export const { run, outcome } = runnersOver(FetchHttpClient.layer)

export const checkPush = (url: string, credentials: { readonly key?: string; readonly admin?: string }) =>
  Effect.flatMap(clientOf(url, credentials), (client) => client.push.check())
