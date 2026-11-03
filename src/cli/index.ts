#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { KeysCommandError, keysCommand } from "api-key-auth/cli"
import { Effect, Layer, Redacted } from "effect"
import { Command } from "effect/cli"
import { ProxyApi } from "../api.ts"
import { configStore } from "../config.ts"
import { ProxyAdminApiKey, ProxyUrl } from "../credentials.ts"
import { auth, keyringLayer } from "../server/credentials.ts"
import { serverCommand } from "./commands/server.ts"
import { serviceCommand } from "./commands/service.ts"
import { tailscaleCommand } from "./commands/tailscale.ts"

// A missing or invalid secret, said in one line like the command's own failures.
const toKeysCommandError = (error: { readonly message: string }) => new KeysCommandError({ message: error.message })

// `proxy keys create | list | revoke` on the Worker at PROXY_URL with PROXY_ADMIN_API_KEY, and `proxy keys migrations`.
const keys = keysCommand({
  api: ProxyApi,
  url: ProxyUrl.resolve.pipe(Effect.map(Redacted.value), Effect.mapError(toKeysCommandError)),
  adminKey: ProxyAdminApiKey.resolve.pipe(Effect.mapError(toKeysCommandError)),
})

const proxy = Command.make("proxy").pipe(
  Command.withDescription("Proxy that sets api keys on requests from the tailnet"),
  Command.withSubcommands([serverCommand, serviceCommand, tailscaleCommand, keys, configStore().commands(), ...auth.commands])
)

const MainLive = Layer.mergeAll(BunServices.layer, keyringLayer)

BunRuntime.runMain(Command.run(proxy, { version: "0.1.0" }).pipe(Effect.provide(MainLive)))
