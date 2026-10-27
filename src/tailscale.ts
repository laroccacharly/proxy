import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class TailscaleError extends Schema.TaggedError<TailscaleError>()("TailscaleError", { message: Schema.String }) {}

const StatusJson = Schema.fromJsonString(Schema.Struct({ Self: Schema.Struct({ DNSName: Schema.String }) }))

// Runs tailscale and returns its combined output; fails on a non-zero exit.
const runTailscale: (args: readonly string[]) => Effect.Effect<string, TailscaleError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("runTailscale")(function* runTailscale(args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = `tailscale ${args.join(" ")}`
  const [output, code] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("tailscale", args))
      return yield* Effect.all([Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode], { concurrency: 2 })
    })
  ).pipe(Effect.mapError((cause) => new TailscaleError({ message: `could not run ${command}: ${cause.message}` })))
  if (code !== 0) {
    return yield* new TailscaleError({ message: `${command} exited with ${code}: ${output.trim()}` })
  }
  return output
})

const urlFromDnsName = (dnsName: string, servePort: number) => `https://${dnsName.replace(/\.$/u, "")}:${servePort}`

// Publishes the local server on the tailnet at servePort; rerunning replaces the same mapping.
export const serve = (port: number, servePort: number) => runTailscale(["serve", "--bg", `--https=${servePort}`, `http://127.0.0.1:${port}`])

export const serveStatus = runTailscale(["serve", "status"])

// The URL clients reach the server at.
export const publicUrl: (servePort: number) => Effect.Effect<string, TailscaleError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("publicUrl")(function* publicUrl(servePort: number) {
  const status = yield* runTailscale(["status", "--json"]).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(StatusJson)),
    Effect.mapError((error) => new TailscaleError({ message: error.message }))
  )
  return urlFromDnsName(status.Self.DNSName, servePort)
})
