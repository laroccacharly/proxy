#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { configStore } from "../config.ts"
import { auth, keyringLayer } from "../server/credentials.ts"
import { serverCommand } from "./commands/server.ts"
import { serviceCommand } from "./commands/service.ts"
import { tailscaleCommand } from "./commands/tailscale.ts"

const proxy = Command.make("proxy").pipe(
  Command.withDescription("Proxy that sets api keys on requests from the tailnet"),
  Command.withSubcommands([serverCommand, serviceCommand, tailscaleCommand, configStore().commands(), ...auth.commands])
)

const MainLive = Layer.mergeAll(BunServices.layer, keyringLayer)

BunRuntime.runMain(Command.run(proxy, { version: "0.1.0" }).pipe(Effect.provide(MainLive)))
