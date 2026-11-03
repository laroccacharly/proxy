// The running Worker at PROXY_URL, with PROXY_ADMIN_API_KEY: the environment first, then the OS keyring, as
// `proxy keys` reads them. Run with `bun run test:live`, never by `bun test`: it sends one real Pushover notification.
// Its keys are named live-<time> and deleted afterwards. The rate limit is left alone: it is shared by every consumer.
// Its calls resolve the Worker through Cloudflare DNS, as `proxy keys` does: right after a deploy that creates the domain,
// the machine's resolver, a VPN's say, may still cache "not found".

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import * as CloudflareDns from "effect-lib/cloudflare-dns"
import * as Credentials from "effect-lib/credentials"
import * as Deploy from "effect-lib/deploy"
import * as ProxyClient from "../../src/client/index.ts"
import { ProxyAdminApiKey, ProxyUrl } from "../../src/credentials.ts"
import { checkPush, clientOf, runKeys, runnersOver } from "../support.ts"

const { run, outcome } = runnersOver(CloudflareDns.layer())

const { url, adminKey } = await Effect.runPromise(
  Effect.gen(function* liveCredentials() {
    return { url: Redacted.value(yield* ProxyUrl.resolve), adminKey: Redacted.value(yield* ProxyAdminApiKey.resolve) }
  }).pipe(Effect.provide(Credentials.layer(Credentials.bunKeyring())))
)

// What `bun run deploy` gave the Worker as DEPLOY_VERSION, when it deployed this checkout.
const version = await Effect.runPromise(Deploy.commitVersion(import.meta.dir))

const keyName = (scope: string) => `live-${new Date().toISOString()}-${scope}`

// Every key the test created, deleted at the end, whether the test got to it or not.
const createdIds: Array<string> = []

const createKey = async (scope: "push" | "images") => {
  const created = await run(
    Effect.flatMap(clientOf(url, { admin: adminKey }), (client) => client.apiKeys.create({ payload: { name: keyName(scope), scopes: [scope] } }))
  )
  createdIds.push(created.id)
  return created
}

// `NotFound` when the test deleted it already.
const deleteKey = (id: string) => outcome(Effect.flatMap(clientOf(url, { admin: adminKey }), (client) => client.apiKeys.delete({ params: { id } })))

let pushKey: { readonly id: string; readonly key: string }
let imagesKey: { readonly id: string; readonly key: string }

beforeAll(async () => {
  pushKey = await createKey("push")
  imagesKey = await createKey("images")
})

afterAll(async () => {
  await Promise.all(createdIds.map(deleteKey))
})

test("/health answers ok and the commit of this checkout", async () => {
  const health = await run(Effect.flatMap(clientOf(url), (client) => client.health.check()))
  expect(health).toEqual({ status: "ok", version })
})

describe("proxy keys", () => {
  test("list shows the test's keys by id, never the key", async () => {
    const listed = await runKeys(url, adminKey, ["list"])
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain(pushKey.id)
    expect(listed.stdout).not.toContain(pushKey.key)
  })

  test("delete makes a key answer 401 and leave the list", async () => {
    const created = await createKey("push")
    expect(await outcome(checkPush(url, { key: created.key }))).toBe("ok")
    const deleted = await runKeys(url, adminKey, ["delete", created.id])
    expect(deleted.exitCode).toBe(0)
    expect(await outcome(checkPush(url, { key: created.key }))).toBe("Unauthorized")
    expect((await runKeys(url, adminKey, ["list"])).stdout).not.toContain(created.id)
  })
})

describe("/api/push", () => {
  test("no key, a wrong key and the admin key get 401", async () => {
    expect(await outcome(checkPush(url, {}))).toBe("Unauthorized")
    expect(await outcome(checkPush(url, { key: "pxy_not-a-key" }))).toBe("Unauthorized")
    expect(await outcome(checkPush(url, { key: adminKey }))).toBe("Unauthorized")
  })

  test("a key without the push scope gets 403", async () => {
    expect(await outcome(checkPush(url, { key: imagesKey.key }))).toBe("Forbidden")
  })

  test("ProxyClient.notify reaches Pushover with the Worker's credentials", async () => {
    await run(
      Effect.flatMap(ProxyClient.make({ url, apiKey: pushKey.key }), (client) => client.notify(`Live test of ${version}`, { title: "proxy test:live" }))
    )
  })
})
