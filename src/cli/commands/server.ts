import { Effect, Layer, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { DEFAULT_SERVER_PORT, loadConfig } from "../../config.ts"
import { serverLayer } from "../../server/serve.ts"

const serverPortFlag = Flag.Int("server-port").pipe(Flag.withAlias("p"), Flag.withDescription("Local port to listen on (overrides config)"))

const serveCommand = Command.make(
  "serve",
  { serverPort: Flag.optional(serverPortFlag) },
  Effect.fn("serveCommand")(function* serveCommand({ serverPort }) {
    const config = yield* loadConfig
    const resolved = Option.getOrElse(serverPort, () => config.serverPort ?? DEFAULT_SERVER_PORT)
    yield* Effect.logInfo(`Serving proxy at http://127.0.0.1:${resolved}`)
    return yield* Layer.launch(serverLayer(resolved, config))
  })
).pipe(Command.withDescription("Run the proxy server in the foreground"))

export const serverCommand = Command.make("server").pipe(Command.withDescription("Run the proxy server"), Command.withSubcommands([serveCommand]))
