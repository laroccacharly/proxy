// `bun run pack:client`, the deploy's build step: packs proxy-client, with the PROXY_URL it is deployed for built in, into
// dist/assets/client, which the Worker serves. Consumers install it from there and need no PROXY_URL of their own.

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Redacted } from "effect"
import * as Credentials from "effect-lib/credentials"
import { ProxyUrl } from "../credentials.ts"

const projectRoot = join(import.meta.dir, "../..")
const assetsDir = join(projectRoot, "dist/assets/client")

const urlModule = (url: string) => `import { Option } from "effect"

// The Worker this copy of the client was built for, by \`bun run pack:client\`.
export const builtInUrl: Option.Option<string> = Option.some(${JSON.stringify(url)})
`

// The client's files in a fresh directory, url.ts naming `url`, packed into `destination`, which it replaces.
export const packClient = (url: string, destination: string) =>
  Effect.promise(async () => {
    const staging = await mkdtemp(join(tmpdir(), "proxy-client-"))
    try {
      await cp(join(projectRoot, "client"), staging, { recursive: true })
      await writeFile(join(staging, "url.ts"), urlModule(url))
      await rm(destination, { recursive: true, force: true })
      await Bun.$`bun pm pack --quiet --destination ${destination}`.cwd(staging).quiet()
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  })

const main = Effect.gen(function* main() {
  const url = Redacted.value(yield* ProxyUrl.resolve)
  yield* packClient(url, assetsDir)
  yield* Effect.log(`proxy-client packed into ${assetsDir}, for ${url}`)
}).pipe(Effect.provide(Credentials.layer(Credentials.defaultKeyring())))

if (import.meta.main) {
  BunRuntime.runMain(main)
}
