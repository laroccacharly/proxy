import { join } from "node:path"
import { serviceCommand as systemdServiceCommand } from "effect-lib/systemd"

const repoRoot = join(import.meta.dir, "..", "..", "..")

// `proxy server serve` as a systemd user service, started at login.
export const serviceCommand = systemdServiceCommand({
  name: "proxy",
  description: "proxy server that sets api keys on outgoing requests",
  script: join(repoRoot, "src", "cli", "index.ts"),
  args: ["server", "serve"],
  restart: "always",
  restartSec: 5,
  extra: {
    unit: { After: "network-online.target", Wants: "network-online.target" },
    service: { WorkingDirectory: repoRoot },
  },
})
