import { Console, Effect } from "effect"
import { Command } from "effect/cli"
import { DEFAULT_PORT, DEFAULT_TAILSCALE_PORT, loadConfig } from "../../config.ts"
import { publicUrl, serve, serveStatus } from "../../tailscale.ts"

const setupCommand = Command.make(
  "setup",
  {},
  Effect.fn("tailscaleSetupCommand")(function* tailscaleSetupCommand() {
    const config = yield* loadConfig
    const port = config.port ?? DEFAULT_PORT
    const servePort = config.tailscalePort ?? DEFAULT_TAILSCALE_PORT
    yield* serve(port, servePort)
    const url = yield* publicUrl(servePort)
    yield* Console.log(`Serving 127.0.0.1:${port} on the tailnet at ${url}`)
    yield* Console.log(`On each client: proxy config set url ${url}`)
  })
).pipe(Command.withDescription("Put the proxy server behind tailscale serve"))

const statusCommand = Command.make(
  "status",
  {},
  Effect.fn("tailscaleStatusCommand")(function* tailscaleStatusCommand() {
    const config = yield* loadConfig
    yield* Console.log((yield* serveStatus).trim())
    yield* Console.log(`URL: ${yield* publicUrl(config.tailscalePort ?? DEFAULT_TAILSCALE_PORT)}`)
  })
).pipe(Command.withDescription("Show the tailscale serve config and the proxy URL"))

export const tailscaleCommand = Command.make("tailscale").pipe(
  Command.withDescription("Expose the proxy server to the tailnet"),
  Command.withSubcommands([setupCommand, statusCommand])
)
