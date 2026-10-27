import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import * as JsonStore from "effect-lib/json-store"

export const DEFAULT_PORT = 7300
// Tailscale keys serve configs by HTTPS port, so the proxy gets its own instead of 443.
export const DEFAULT_TAILSCALE_PORT = 8443

export const Config = Schema.Struct({
  // Local port the server listens on, on 127.0.0.1 only.
  port: Schema.optionalKey(Schema.Int),
  // HTTPS port tailscale serve publishes the server on.
  tailscalePort: Schema.optionalKey(Schema.Int),
  // Where clients reach the server, e.g. https://pi.tailnet.ts.net:8443.
  url: Schema.optionalKey(Schema.String),
  // OpenAI API origin the server calls, for a compatible API or a fake one in tests.
  openaiOrigin: Schema.optionalKey(Schema.String),
})

export type Config = typeof Config.Type

const configHome = () => process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config")

export const configStore = () => JsonStore.make(join(configHome(), "proxy", "config.json"), Config)

// The stored config, empty when the file does not exist yet.
export const loadConfig = Effect.suspend(() => configStore().load).pipe(Effect.map(Option.getOrElse((): Config => ({}))))
