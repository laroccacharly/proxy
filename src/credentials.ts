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

// One consumer's key, from `proxy keys create`: PROXY_API_KEY, else the OS keyring. It calls the upstream apis only.
export const ProxyApiKey = Credentials.secret("PROXY_API_KEY", { label: "proxy API key", schema: Schema.String.check(Schema.isStartingWith("pxy_")) })

// Where Lake, the event store each push is recorded in, is reached.
export const LakeUrl = Credentials.secret("LAKE_URL", { label: "lake Worker URL", schema: Origin, sensitive: false })

// The Worker's write-only Lake key; not LAKE_API_KEY, the owner's key in the same keyring.
export const ProxyLakeApiKey = Credentials.secret("PROXY_LAKE_API_KEY", { label: "proxy's lake API key", schema: Schema.String.check(Schema.isStartingWith("lake_")) })

// `proxy login` and `proxy auth login | logout | status`, on a consumer machine.
export const consumerCredentials = Credentials.make([ProxyUrl, ProxyApiKey])
