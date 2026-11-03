// `bun run deploy`, for whoever deploys the Worker, never part of the `proxy` CLI. `bun run deploy login` keeps its
// secrets in the OS keyring: where the Worker is reached, PROXY_URL, which `proxy keys` reads too, the admin key, and
// the upstreams' credentials, under the same names as every other app that uses them. It deploys this checkout's
// commit as DEPLOY_VERSION, then waits for PROXY_URL/health to answer it.

import * as Deploy from "effect-lib/deploy"
import * as OpenAIImage from "effect-lib/openai-image"
import * as Push from "effect-lib/push"
import { ProxyAdminApiKey, ProxyUrl } from "../credentials.ts"
import { version } from "../version.ts"

Deploy.run({ app: "proxy", url: ProxyUrl, secrets: [ProxyAdminApiKey, Push.AppToken, Push.UserKey, OpenAIImage.ApiKey] }, { version })
