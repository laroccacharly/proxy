import { Schema } from "effect"
import * as Credentials from "effect-lib/credentials"

// An https origin without a path, e.g. `https://proxy.example.com`, or a local Worker, e.g. `http://localhost:1340`.
const Origin = Schema.String.check(
  Schema.isPattern(/^(?:https:\/\/[^/\s]+|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)$/u, {
    expected: "an https origin without a path, e.g. https://proxy.example.com, or http://localhost:<port>",
  })
)

// Where the Worker is reached: PROXY_URL, else the OS keyring.
export const ProxyUrl = Credentials.secret("PROXY_URL", { label: "proxy Worker URL", schema: Origin, sensitive: false })

// Creates, lists and revokes the consumer keys; it calls no upstream api.
export const ProxyAdminApiKey = Credentials.secret("PROXY_ADMIN_API_KEY", { label: "proxy admin API key" })
