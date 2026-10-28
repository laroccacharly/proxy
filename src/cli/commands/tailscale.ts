import { tailscaleCommand as makeTailscaleCommand } from "effect-lib/tailscale"
import { loadPorts } from "../../config.ts"

// `proxy tailscale install | status | url | uninstall`; then on each client: proxy config set url <URL>.
export const tailscaleCommand = makeTailscaleCommand({ name: "proxy", ports: loadPorts })
