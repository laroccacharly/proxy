// The Worker's HttpApi in Bun, over SQLite in memory with the tables from ./migrations, behind a real port so the
// typed client and the `proxy keys` command reach it as they would the Worker. A fake Pushover stands in upstream.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { ApiKeyAuth } from "api-key-auth"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, type HttpClient, HttpRouter, HttpServer } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { ProxyApi } from "../src/api.ts"
import { rateLimitGuard, routes } from "../src/worker/http.ts"

const ADMIN_API_KEY = "test-proxy-admin-api-key"
const PUSH_APP_TOKEN = "test-push-app-token"
const PUSH_USER_KEY = "test-push-user-key"
const projectRoot = join(import.meta.dir, "..")
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

// The Worker's env, as `alchemy dev` would set it.
const workerEnv = {
  PROXY_ADMIN_API_KEY: ADMIN_API_KEY,
  PUSH_APP_TOKEN,
  PUSH_USER_KEY,
  PUSH_ORIGIN: pushover.url.origin,
}

interface TestWorker {
  readonly url: string
  // How many calls reached the rate limit.
  readonly rateLimitCalls: () => number
  readonly stop: () => Promise<void>
}

// A fresh database each, and a rate limit that lets everything through, or nothing.
const startWorker = (options: { readonly withinRateLimit: boolean }): TestWorker => {
  let rateLimitCalls = 0
  const isWithinRateLimit = Effect.sync(() => {
    rateLimitCalls++
    return options.withinRateLimit
  })
  const { handler, dispose } = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provide([rateLimitGuard(isWithinRateLimit), migratedSqlite, HttpServer.layerServices]),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(workerEnv)))
    ),
    { disableLogger: true }
  )
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handler(request) })
  return {
    url: server.url.origin,
    rateLimitCalls: () => rateLimitCalls,
    stop: async () => {
      await server.stop(true)
      await dispose()
    },
  }
}

// `proxy keys …` against `worker`, with the admin key from the environment.
const runKeys = async (worker: TestWorker, args: ReadonlyArray<string>, adminKey = ADMIN_API_KEY) => {
  const child = Bun.spawn(["bun", join(projectRoot, "src", "cli", "index.ts"), "keys", ...args], {
    env: { ...process.env, PROXY_URL: worker.url, PROXY_ADMIN_API_KEY: adminKey },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout: stdout.trim(), stderr, exitCode }
}

// The typed client, sending `key` as a consumer or `admin` as the admin, or nothing.
const clientOf = (worker: TestWorker, credentials: { readonly key?: string; readonly admin?: string } = {}) => {
  const middlewares = []
  if (credentials.key !== undefined) {
    middlewares.push(ApiKeyAuth.layerClient(Redacted.make(credentials.key)))
  }
  if (credentials.admin !== undefined) {
    middlewares.push(ApiKeyAuth.layerAdminClient(Redacted.make(credentials.admin)))
  }
  return HttpApiClient.make(ProxyApi, { baseUrl: worker.url }).pipe(Effect.provide(Layer.mergeAll(Layer.empty, ...middlewares)))
}

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => Effect.runPromise(effect.pipe(Effect.provide(FetchHttpClient.layer)))

// The tag of the error `effect` fails with, or `ok`.
const outcome = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  run(effect.pipe(Effect.as("ok"), Effect.catch((error) => Effect.succeed(error._tag))))

const checkPush = (worker: TestWorker, credentials: { readonly key?: string; readonly admin?: string }) =>
  Effect.flatMap(clientOf(worker, credentials), (client) => client.push.check())

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
})

test("/health answers with no key", async () => {
  const health = await run(Effect.flatMap(clientOf(worker), (client) => client.health.check()))
  expect(health).toEqual({ status: "ok" })
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

describe("POST /api/push", () => {
  const notify = (credentials: { readonly key?: string; readonly admin?: string }, payload: { readonly message: string; readonly title?: string }) =>
    Effect.flatMap(clientOf(worker, credentials), (client) => client.push.notify({ payload }))

  test("the fake Pushover gets the message, the title, and the Worker's token and user key", async () => {
    const key = await createKey(worker, "laptop", ["push"])
    fakePushover.received = []
    await run(notify({ key }, { message: "build done", title: "ci" }))
    expect(fakePushover.received).toEqual([{ token: PUSH_APP_TOKEN, user: PUSH_USER_KEY, message: "build done", title: "ci" }])
  })

  test("no key, a wrong key, the admin key and a key without the push scope reach no Pushover", async () => {
    const painter = await createKey(worker, "painter", ["images"])
    fakePushover.received = []
    expect(await outcome(notify({}, { message: "hi" }))).toBe("Unauthorized")
    expect(await outcome(notify({ key: "pxy_not-a-key" }, { message: "hi" }))).toBe("Unauthorized")
    expect(await outcome(notify({ key: ADMIN_API_KEY }, { message: "hi" }))).toBe("Unauthorized")
    expect(await outcome(notify({ key: painter }, { message: "hi" }))).toBe("Forbidden")
    expect(fakePushover.received).toEqual([])
  })

  test("Pushover answering status 0 is a ProxyError with its reasons", async () => {
    const key = await createKey(worker, "laptop", ["push"])
    fakePushover.rejecting = true
    const error = await run(Effect.flip(notify({ key }, { message: "hi" }))).finally(() => {
      fakePushover.rejecting = false
    })
    expect(error._tag).toBe("ProxyError")
    expect(error.message).toContain("application token is invalid")
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
