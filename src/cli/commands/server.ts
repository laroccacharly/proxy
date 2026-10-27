import { Effect, Layer, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { DEFAULT_PORT, loadConfig } from "../../config.ts"
import { serverLayer } from "../../server/serve.ts"

const portFlag = Flag.Int("port").pipe(Flag.withAlias("p"), Flag.withDescription("Local port to listen on (overrides config)"))

const serveCommand = Command.make(
  "serve",
  { port: Flag.optional(portFlag) },
  Effect.fn("serveCommand")(function* serveCommand({ port }) {
    const config = yield* loadConfig
    const resolved = Option.getOrElse(port, () => config.port ?? DEFAULT_PORT)
    yield* Effect.logInfo(`Serving proxy at http://127.0.0.1:${resolved}`)
    return yield* Layer.launch(serverLayer(resolved, config))
  })
).pipe(Command.withDescription("Run the proxy server in the foreground"))

export const serverCommand = Command.make("server").pipe(Command.withDescription("Run the proxy server"), Command.withSubcommands([serveCommand]))
