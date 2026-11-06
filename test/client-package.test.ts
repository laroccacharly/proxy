// proxy-client as consumers install it: the tarball `bun run pack:client` builds, which the Worker serves.

import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { packClient } from "../src/deploy/pack-client.ts"
import { projectRoot } from "./support.ts"

const clientDir = join(projectRoot, "client")

test("the tarball holds the client, its api and the deployed URL, nothing else", async () => {
  const destination = join(await mkdtemp(join(tmpdir(), "proxy-client-")), "client")
  await Effect.runPromise(packClient("https://proxy.example.com", destination))
  const { version } = JSON.parse(await readFile(join(clientDir, "package.json"), "utf8"))
  const tarball = join(destination, `proxy-client-${version}.tgz`)
  expect(await readdir(destination)).toEqual([`proxy-client-${version}.tgz`])

  const listed = await Bun.$`tar tzf ${tarball}`.text()
  expect(listed.trim().split("\n").toSorted()).toEqual(["package/api.ts", "package/index.ts", "package/package.json", "package/url.ts"])
  expect(await Bun.$`tar xzOf ${tarball} package/url.ts`.text()).toContain(`Option.some("https://proxy.example.com")`)
})

test("the client imports only effect, api-key-auth and its own files", async () => {
  const sources = await Promise.all(["api.ts", "index.ts", "url.ts"].map((file) => readFile(join(clientDir, file), "utf8")))
  const imported = sources.flatMap((source) => [...source.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]))
  expect(imported.filter((specifier) => !/^(?:effect(?:\/.*)?|api-key-auth|\.\/[\w-]+\.ts)$/u.test(specifier ?? ""))).toEqual([])
})
