import { tailscaleCommand as makeTailscaleCommand } from "effect-lib/tailscale"
import { loadPorts } from "../../config.ts"

// `proxy tailscale install | status | url | uninstall`, for the Pi server until phase 6 of docs/migration.md.
export const tailscaleCommand = makeTailscaleCommand({ name: "proxy", ports: loadPorts })
