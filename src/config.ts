import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, type FileSystem, Option, Schema } from "effect"
import * as JsonStore from "effect-lib/json-store"
import { TailscalePort, type Ports } from "effect-lib/tailscale"

export const DEFAULT_SERVER_PORT = 7300
// Tailscale keys serve configs by HTTPS port, so the proxy gets its own instead of 443, apart from memo's 8443 and cterm's 8444.
export const DEFAULT_TAILSCALE_PORT = 8445
export const DEFAULT_IMAGES_PER_HOUR = 30

export const Config = Schema.Struct({
  // Local port the server listens on, on 127.0.0.1 only.
  serverPort: Schema.optionalKey(Schema.Int),
  // HTTPS port tailscale serve publishes the server on.
  tailscalePort: Schema.optionalKey(TailscalePort),
  // Where clients reach the server, e.g. https://pi.tailnet.ts.net:8445.
  url: Schema.optionalKey(Schema.String),
  // OpenAI API origin the server calls, for a compatible API or a fake one in tests.
  openaiOrigin: Schema.optionalKey(Schema.String),
  // Images the server generates per hour across all clients, to cap OpenAI spending.
  imagesPerHour: Schema.optionalKey(Schema.Int),
})

export type Config = typeof Config.Type

const configHome = () => process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config")

export const configStore = () => JsonStore.make(join(configHome(), "proxy", "config.json"), Config)

// The stored config, empty when the file does not exist yet.
export const loadConfig = Effect.suspend(() => configStore().load).pipe(Effect.map(Option.getOrElse((): Config => ({}))))

// The server port and the tailscale port, with their defaults.
export const loadPorts: Effect.Effect<Ports, JsonStore.JsonStoreError, FileSystem.FileSystem> = loadConfig.pipe(
  Effect.map((config) => ({ serverPort: config.serverPort ?? DEFAULT_SERVER_PORT, tailscalePort: config.tailscalePort ?? DEFAULT_TAILSCALE_PORT }))
)
