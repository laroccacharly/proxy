import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { ProxyClient } from "../src/client/index.ts"

const API_KEY = "dummy-openai-key"
// The tests below make this many requests before the rate-limit test, which then goes over.
const IMAGES_PER_HOUR = 2
const FAKE_PNG = "fake-png-bytes"

interface ReceivedRequest {
  readonly authorization: string | null
  readonly prompt: string
}

// Answers like OpenAI Images: a base64 PNG when the bearer key matches, a 401 otherwise, a 500 for the prompt "fail".
const startFakeOpenAI = (received: ReceivedRequest[]) =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/v1/images/generations": {
        POST: async (request) => {
          const body = (await request.json()) as { prompt: string }
          const authorization = request.headers.get("authorization")
          received.push({ authorization, prompt: body.prompt })
          if (authorization !== `Bearer ${API_KEY}`) {
            return Response.json({ error: { message: "bad key" } }, { status: 401 })
          }
          if (body.prompt === "fail") {
            return Response.json({ error: { message: "upstream exploded" } }, { status: 500 })
          }
          return Response.json({ data: [{ b64_json: Buffer.from(FAKE_PNG).toString("base64") }] })
        },
      },
    },
  })

const freePort = () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = probe.port ?? 0
  void probe.stop(true)
  return port
}

const waitForHealth = async (url: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const healthy = await fetch(`${url}/health`).then(
      (response) => response.ok,
      () => false
    )
    if (healthy) {
      return
    }
    await Bun.sleep(50)
  }
  throw new Error(`proxy server at ${url} never became healthy`)
}

const received: ReceivedRequest[] = []
const fakeOpenAI = startFakeOpenAI(received)
const port = freePort()
const proxyUrl = `http://127.0.0.1:${port}`
const configHome = mkdtempSync(join(tmpdir(), "proxy-e2e-"))
mkdirSync(join(configHome, "proxy"))
writeFileSync(join(configHome, "proxy", "config.json"), JSON.stringify({ serverPort: port, openaiOrigin: fakeOpenAI.url.origin, imagesPerHour: IMAGES_PER_HOUR }))
// The dummy key comes from the environment, which the server reads before the keyring.
const server = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli", "index.ts"), "server", "serve"], {
  env: { ...process.env, XDG_CONFIG_HOME: configHome, OPENAI_API_KEY: API_KEY },
  stdout: "inherit",
  stderr: "inherit",
})

beforeAll(async () => {
  await waitForHealth(proxyUrl)
})

afterAll(async () => {
  server.kill()
  await server.exited
  await fakeOpenAI.stop(true)
  rmSync(configHome, { recursive: true, force: true })
})

const generateImage = (prompt: string) =>
  ProxyClient.use((client) => client.generateImage(prompt, { aspect: "1:1" })).pipe(Effect.provide(ProxyClient.layer({ url: proxyUrl })))

test("the client gets the fake api's image, with the api key set by the proxy server", async () => {
  const png = await Effect.runPromise(generateImage("a cat"))

  expect(new TextDecoder().decode(png)).toBe(FAKE_PNG)
  expect(received.at(-1)).toEqual({ authorization: `Bearer ${API_KEY}`, prompt: "a cat" })
})

test("an upstream failure reaches the client as a ProxyError with the api's message", async () => {
  const error = await Effect.runPromise(Effect.flip(generateImage("fail")))

  expect(error._tag).toBe("ProxyError")
  expect(error.message).toContain("upstream exploded")
})

test("past imagesPerHour the client gets RateLimited and the fake api is not called", async () => {
  const before = received.length
  const error = await Effect.runPromise(Effect.flip(generateImage("one too many")))

  expect(error._tag).toBe("RateLimited")
  expect(error.message).toContain(`${IMAGES_PER_HOUR} per hour`)
  expect(received.length).toBe(before)
})
