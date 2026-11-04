// The Worker's HttpApi in Bun, over SQLite in memory with the tables from ./migrations, behind a real port so the
// typed client and the `proxy keys` command reach it as they would the Worker. A fake Pushover and a fake OpenAI
// stand in upstream, and a fake Lake records the pushes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import type { NewEvent } from "lake-client"
import { ProxyClient } from "../src/client/index.ts"
import { Background, rateLimitGuard, routes } from "../src/worker/http.ts"
import { checkPush as checkPushAt, clientOf as clientAt, outcome, projectRoot, run, runKeys as runSupportKeys } from "./support.ts"

const ADMIN_API_KEY = "test-proxy-admin-api-key"
const PUSH_APP_TOKEN = "test-push-app-token"
const PUSH_USER_KEY = "test-push-user-key"
const OPENAI_API_KEY = "test-openai-api-key"
const LAKE_API_KEY = "lake_test-proxy-lake-api-key"
const FAKE_PNG = "fake-png-bytes"
const VERSION = "test-version"
const migrationsDir = join(projectRoot, "migrations")

// The statements of ./migrations, in the order alchemy applies them.
const migrationStatements = readdirSync(migrationsDir)
  .toSorted()
  .flatMap((name) => readFileSync(join(migrationsDir, name), "utf8").split(/;\n/u))
  .map((statement) => statement.trim())
  .filter((statement) => statement !== "")

const migratedSqlite = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of migrationStatements) {
      yield* sql.unsafe(statement)
    }
  })
).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

// Answers like Pushover, and keeps what it gets; `rejecting` makes it refuse with `status: 0` and its reasons.
const fakePushover = {
  received: [] as Array<Record<string, string>>,
  rejecting: false,
}
const pushover = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/1/messages.json": {
      POST: async (request) => {
        fakePushover.received.push(await request.json())
        if (fakePushover.rejecting) {
          return Response.json({ status: 0, errors: ["application token is invalid"] }, { status: 400 })
        }
        return Response.json({ status: 1, request: "r" })
      },
    },
  },
})

// Answers like OpenAI Images: a base64 PNG, or a 500 for the prompt "fail"; keeps the bearer and the prompt it gets.
const fakeOpenAI = {
  received: [] as Array<{ readonly authorization: string | null; readonly prompt: string; readonly size: string }>,
}
const openai = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/v1/images/generations": {
      POST: async (request) => {
        const body = (await request.json()) as { prompt: string; size: string }
        fakeOpenAI.received.push({ authorization: request.headers.get("authorization"), prompt: body.prompt, size: body.size })
        if (body.prompt === "fail") {
          return Response.json({ error: { message: "upstream exploded" } }, { status: 500 })
        }
        return Response.json({ data: [{ b64_json: Buffer.from(FAKE_PNG).toString("base64") }] })
      },
    },
  },
})

// Answers like Lake's POST /events, and keeps the bearer and the event it gets; `down` makes it answer 503.
const fakeLake = {
  received: [] as Array<{ readonly authorization: string | null; readonly event: NewEvent }>,
  down: false,
}
const lake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/events": {
      POST: async (request) => {
        if (fakeLake.down) {
          return new Response("down", { status: 503 })
        }
        fakeLake.received.push({ authorization: request.headers.get("authorization"), event: await request.json() })
        return Response.json({ ids: ["01JB0000000000000000000000"] })
      },
    },
  },
})

// The Worker's env, as `alchemy dev` would set it.
const workerEnv = {
  PROXY_ADMIN_API_KEY: ADMIN_API_KEY,
  PUSH_APP_TOKEN,
  PUSH_USER_KEY,
  PUSH_ORIGIN: pushover.url.origin,
  OPENAI_API_KEY,
  OPENAI_ORIGIN: openai.url.origin,
  LAKE_URL: lake.url.origin,
  PROXY_LAKE_API_KEY: LAKE_API_KEY,
  DEPLOY_VERSION: VERSION,
}

interface TestWorker {
  readonly url: string
  // How many calls reached the rate limit.
  readonly rateLimitCalls: () => number
  // Until the work the requests so far left in the Background is done.
  readonly settled: () => Promise<void>
  readonly stop: () => Promise<void>
}

// A fresh database each, and a rate limit that lets everything through, or nothing.
const startWorker = (options: { readonly withinRateLimit: boolean }): TestWorker => {
  let rateLimitCalls = 0
  const isWithinRateLimit = Effect.sync(() => {
    rateLimitCalls++
    return options.withinRateLimit
  })
  // Like ctx.waitUntil: the work runs on its own, with the caller's context, and the request doesn't wait for it.
  const pending: Array<Promise<void>> = []
  const background = Layer.succeed(
    Background,
    Background.of({ run: (effect) => Effect.flatMap(Effect.context(), (context) => Effect.sync(() => pending.push(Effect.runPromiseWith(context)(effect)))) })
  )
  const { handler, dispose } = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provide([rateLimitGuard(isWithinRateLimit), background, migratedSqlite, HttpServer.layerServices]),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(workerEnv)))
    ),
    { disableLogger: true }
  )
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handler(request) })
  return {
    url: server.url.origin,
    rateLimitCalls: () => rateLimitCalls,
    settled: async () => {
      await Promise.all(pending)
    },
    stop: async () => {
      await server.stop(true)
      await dispose()
    },
  }
}

const runKeys = (worker: TestWorker, args: ReadonlyArray<string>, adminKey = ADMIN_API_KEY) => runSupportKeys(worker.url, adminKey, args)

const clientOf = (worker: TestWorker, credentials: { readonly key?: string; readonly admin?: string } = {}) => clientAt(worker.url, credentials)

const checkPush = (worker: TestWorker, credentials: { readonly key?: string; readonly admin?: string }) => checkPushAt(worker.url, credentials)

const createKey = (worker: TestWorker, name: string, scopes: readonly [string, ...Array<string>]) =>
  run(Effect.flatMap(clientOf(worker, { admin: ADMIN_API_KEY }), (client) => client.apiKeys.create({ payload: { name, scopes } }))).then(
    (created) => created.key
  )

let worker: TestWorker

beforeAll(() => {
  worker = startWorker({ withinRateLimit: true })
})

afterAll(async () => {
  await worker.stop()
  await pushover.stop(true)
  await openai.stop(true)
  await lake.stop(true)
})

test("/health answers the version with no key", async () => {
  const health = await run(Effect.flatMap(clientOf(worker), (client) => client.health.check()))
  expect(health).toEqual({ status: "ok", version: VERSION })
})

describe("proxy keys", () => {
  test("create prints only the new pxy_ key, which may push", async () => {
    const created = await runKeys(worker, ["create", "laptop", "--scope", "push"])
    expect(created.exitCode).toBe(0)
    expect(created.stdout).toMatch(/^pxy_[\w-]{43}$/u)

    const caller = await run(checkPush(worker, { key: created.stdout }))
    expect(caller.name).toBe("laptop")
    expect(caller.scopes).toEqual(["push"])
  })

  test("list shows a key by its id, revoke by that id makes it answer 401", async () => {
    const key = await createKey(worker, "agent", ["push"])
    const { id } = await run(checkPush(worker, { key }))

    const listed = await runKeys(worker, ["list"])
    expect(listed.stdout).toContain(id)
    expect(listed.stdout).not.toContain(key)

    const revoked = await runKeys(worker, ["revoke", id])
    expect(revoked.exitCode).toBe(0)
    expect(await outcome(checkPush(worker, { key }))).toBe("Unauthorized")
    expect((await runKeys(worker, ["list"])).stdout).toMatch(new RegExp(`${id}.*revoked`, "u"))
  })

  test("delete by id makes the key answer 401 and leave the list", async () => {
    const key = await createKey(worker, "temporary", ["push"])
    const { id } = await run(checkPush(worker, { key }))
    const deleted = await runKeys(worker, ["delete", id])
    expect(deleted.exitCode).toBe(0)
    expect(await outcome(checkPush(worker, { key }))).toBe("Unauthorized")
    expect((await runKeys(worker, ["list"])).stdout).not.toContain(id)
  })

  test("a wrong admin key fails in one line", async () => {
    const listed = await runKeys(worker, ["list"], "not-the-admin-key")
    expect(listed.exitCode).not.toBe(0)
    expect(listed.stderr).toContain("refused the admin key")
  })

  test("only the push and images scopes, or all, are accepted", async () => {
    const created = await runKeys(worker, ["create", "x", "--scope", "push", "--scope", "images"])
    expect(created.exitCode).toBe(0)
    const refused = await outcome(
      Effect.flatMap(clientOf(worker, { admin: ADMIN_API_KEY }), (client) => client.apiKeys.create({ payload: { name: "x", scopes: ["mail"] } }))
    )
    expect(refused).toBe("UnknownScope")
  })

  test("migrations check passes on ./migrations", async () => {
    const checked = await runKeys(worker, ["migrations", "check", migrationsDir])
    expect(checked.stderr).toContain("unedited")
    expect(checked.exitCode).toBe(0)
  })
})

describe("/api/push", () => {
  test("no key and a wrong key get 401", async () => {
    expect(await outcome(checkPush(worker, {}))).toBe("Unauthorized")
    expect(await outcome(checkPush(worker, { key: "pxy_not-a-key" }))).toBe("Unauthorized")
  })

  test("a key without the push scope gets 403", async () => {
    const key = await createKey(worker, "painter", ["images"])
    expect(await outcome(checkPush(worker, { key }))).toBe("Forbidden")
  })

  test("the two kinds of key are never interchangeable", async () => {
    const key = await createKey(worker, "laptop", ["all"])
    expect(await outcome(checkPush(worker, { key: ADMIN_API_KEY }))).toBe("Unauthorized")
    const listedWithConsumerKey = Effect.flatMap(clientOf(worker, { admin: key }), (client) => client.apiKeys.list({ query: {} }))
    expect(await outcome(listedWithConsumerKey)).toBe("Unauthorized")
  })
})

describe("ProxyClient.notify", () => {
  const notify = (apiKey: string, message: string, options?: { readonly title?: string }) =>
    ProxyClient.use((client) => client.notify(message, options)).pipe(Effect.provide(ProxyClient.layer({ url: worker.url, apiKey })))

  const notifyOutcome = (apiKey: string) => Effect.runPromise(notify(apiKey, "hi").pipe(Effect.as("ok"), Effect.catch((error) => Effect.succeed(error._tag))))

  test("the fake Pushover gets the message, the title, and the Worker's token and user key", async () => {
    const key = await createKey(worker, "laptop", ["push"])
    fakePushover.received = []
    await Effect.runPromise(notify(key, "build done", { title: "ci" }))
    expect(fakePushover.received).toEqual([{ token: PUSH_APP_TOKEN, user: PUSH_USER_KEY, message: "build done", title: "ci" }])
  })

  test("layer() reads PROXY_URL and PROXY_API_KEY from the environment", async () => {
    const key = await createKey(worker, "agent", ["push"])
    fakePushover.received = []
    await Effect.runPromise(
      ProxyClient.use((client) => client.notify("from the env")).pipe(
        Effect.provide(ProxyClient.layer().pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PROXY_URL: worker.url, PROXY_API_KEY: key })))))
      )
    )
    expect(fakePushover.received.map(({ message }) => message)).toEqual(["from the env"])
  })

  test("a wrong key, a revoked key and the admin key get Unauthorized, a key without the push scope Forbidden, and none reach Pushover", async () => {
    const painter = await createKey(worker, "painter", ["images"])
    const revoked = await createKey(worker, "old", ["push"])
    const { id } = await run(checkPush(worker, { key: revoked }))
    await run(Effect.flatMap(clientOf(worker, { admin: ADMIN_API_KEY }), (client) => client.apiKeys.revoke({ params: { id } })))
    fakePushover.received = []
    expect(await notifyOutcome("pxy_not-a-key")).toBe("Unauthorized")
    expect(await notifyOutcome(revoked)).toBe("Unauthorized")
    expect(await notifyOutcome(ADMIN_API_KEY)).toBe("Unauthorized")
    expect(await notifyOutcome(painter)).toBe("Forbidden")
    expect(fakePushover.received).toEqual([])
  })

  test("Pushover answering status 0 is a ProxyError with its reasons", async () => {
    const key = await createKey(worker, "laptop", ["push"])
    fakePushover.rejecting = true
    const error = await Effect.runPromise(Effect.flip(notify(key, "hi"))).finally(() => {
      fakePushover.rejecting = false
    })
    expect(error._tag).toBe("ProxyError")
    expect(error.message).toContain("application token is invalid")
  })

  test("a push sent is recorded in Lake as push.sent, by the calling key's name, with the Worker's Lake key", async () => {
    const key = await createKey(worker, "recorder", ["push"])
    fakeLake.received = []
    const before = Date.now()
    await Effect.runPromise(notify(key, "deployed", { title: "ci" }))
    await worker.settled()
    expect(fakeLake.received).toEqual([
      {
        authorization: `Bearer ${LAKE_API_KEY}`,
        event: { source: "proxy", type: "push.sent", occurred_at: expect.any(Number), subject: "recorder", data: { message: "deployed", title: "ci" } },
      },
    ])
    expect(fakeLake.received[0]?.event.occurred_at).toBeGreaterThanOrEqual(before)
  })

  test("a push Pushover refuses, or a call refused, records nothing in Lake", async () => {
    const key = await createKey(worker, "laptop", ["push"])
    const painter = await createKey(worker, "painter", ["images"])
    fakeLake.received = []
    fakePushover.rejecting = true
    const outcomes = await Promise.all([notifyOutcome(key), notifyOutcome(painter)]).finally(() => {
      fakePushover.rejecting = false
    })
    await worker.settled()
    expect(outcomes).toEqual(["ProxyError", "Forbidden"])
    expect(fakeLake.received).toEqual([])
  })

  test("Lake down doesn't fail the push", async () => {
    const key = await createKey(worker, "laptop", ["push"])
    fakeLake.down = true
    fakePushover.received = []
    const pushed = await notifyOutcome(key)
    await worker.settled().finally(() => {
      fakeLake.down = false
    })
    expect(pushed).toBe("ok")
    expect(fakePushover.received.map(({ message }) => message)).toEqual(["hi"])
  })

  test("an unreachable Worker is a ProxyError", async () => {
    const error = await Effect.runPromise(
      Effect.flip(ProxyClient.use((client) => client.notify("hi")).pipe(Effect.provide(ProxyClient.layer({ url: "http://127.0.0.1:1", apiKey: "pxy_x" }))))
    )
    expect(error._tag).toBe("ProxyError")
  })
})

describe("ProxyClient.generateImage", () => {
  const generateImage = (apiKey: string, prompt: string) =>
    ProxyClient.use((client) => client.generateImage(prompt, { aspect: "1:1" })).pipe(Effect.provide(ProxyClient.layer({ url: worker.url, apiKey })))

  test("the client gets the fake OpenAI's PNG, generated with the Worker's key", async () => {
    const key = await createKey(worker, "painter", ["images"])
    fakeOpenAI.received = []
    const png = await Effect.runPromise(generateImage(key, "a cat"))
    expect(new TextDecoder().decode(png)).toBe(FAKE_PNG)
    expect(fakeOpenAI.received).toEqual([{ authorization: `Bearer ${OPENAI_API_KEY}`, prompt: "a cat", size: "1024x1024" }])
  })

  test("an upstream failure is a ProxyError with OpenAI's message", async () => {
    const key = await createKey(worker, "painter", ["images"])
    const error = await Effect.runPromise(Effect.flip(generateImage(key, "fail")))
    expect(error._tag).toBe("ProxyError")
    expect(error.message).toContain("upstream exploded")
  })

  test("a key with only the push scope gets Forbidden and reaches no OpenAI", async () => {
    const key = await createKey(worker, "laptop", ["push"])
    fakeOpenAI.received = []
    const error = await Effect.runPromise(Effect.flip(generateImage(key, "a cat")))
    expect(error._tag).toBe("Forbidden")
    expect(fakeOpenAI.received).toEqual([])
  })
})

describe("over the rate limit", () => {
  let limited: TestWorker

  beforeAll(() => {
    limited = startWorker({ withinRateLimit: false })
  })

  afterAll(() => limited.stop())

  test("a valid key gets 429 RateLimited", async () => {
    const key = await createKey(limited, "laptop", ["push"])
    expect(await outcome(checkPush(limited, { key }))).toBe("RateLimited")
  })

  test("a call without a valid key gets 401 and spends none of the limit", async () => {
    const before = limited.rateLimitCalls()
    expect(await outcome(checkPush(limited, { key: "pxy_not-a-key" }))).toBe("Unauthorized")
    expect(limited.rateLimitCalls()).toBe(before)
  })
})
