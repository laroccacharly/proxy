import { Option } from "effect"

// The Worker this copy of the client calls when neither the options nor PROXY_URL name one. None here; in the tarball
// the Worker serves, the PROXY_URL it was deployed for, written by `bun run pack:client`.
export const builtInUrl: Option.Option<string> = Option.none()
