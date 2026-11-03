#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { KeysCommandError, keysCommand } from "api-key-auth/cli"
import { Effect, Layer, Redacted } from "effect"
import { Command } from "effect/cli"
import * as CloudflareDns from "effect-lib/cloudflare-dns"
import * as Credentials from "effect-lib/credentials"
import { ProxyApi } from "../api.ts"
import { consumerCredentials, ProxyAdminApiKey, ProxyUrl } from "../credentials.ts"
import { version } from "../version.ts"

// A missing or invalid secret, said in one line like the command's own failures.
const toKeysCommandError = (error: { readonly message: string }) => new KeysCommandError({ message: error.message })

// `proxy keys create | list | revoke` on the Worker at PROXY_URL with PROXY_ADMIN_API_KEY, and `proxy keys migrations`.
const keys = keysCommand({
  api: ProxyApi,
  url: ProxyUrl.resolve.pipe(Effect.map(Redacted.value), Effect.mapError(toKeysCommandError)),
  adminKey: ProxyAdminApiKey.resolve.pipe(Effect.mapError(toKeysCommandError)),
})

const proxy = Command.make("proxy").pipe(
  Command.withDescription("Typed proxy on a Cloudflare Worker that holds the upstream api keys"),
  Command.withSubcommands([keys, ...consumerCredentials.commands])
)

// The Worker resolves through Cloudflare DNS, so `proxy keys` reaches a domain the deploy just created.
const MainLive = Layer.mergeAll(BunServices.layer, CloudflareDns.layer(), consumerCredentials.layer(Credentials.bunKeyring()))

BunRuntime.runMain(Command.run(proxy, { version }).pipe(Effect.provide(MainLive)))
