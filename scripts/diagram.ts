// Renders docs/proxy-vs-agent-vault.png: the typed proxy next to Agent Vault's generic HTTPS proxy.
import { join } from "node:path"
import { Resvg } from "@resvg/resvg-js"

const OUTPUT = join(import.meta.dir, "..", "docs", "proxy-vs-agent-vault.png")
const WIDTH = 2000
const HEIGHT = 1620

const RED = "#e03131"
const ORANGE = "#f08c00"
const GRAY = "#868e96"
const BLACK = "#1e1e1e"
const GREEN = "#2f9e44"
const BLUE = "#1971c2"
const PURPLE = "#9c36b5"

interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface Stroke {
  readonly color?: string
  readonly dashed?: boolean
  readonly width?: number
}

interface BoxStyle extends Stroke {
  readonly size?: number
}

const parts: string[] = []

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")

const strokeAttributes = ({ color = BLACK, dashed = false, width = 2 }: Stroke) => {
  const solid = `stroke="${color}" stroke-width="${width}"`
  if (!dashed) {
    return solid
  }
  return `${solid} stroke-dasharray="8 6"`
}

// Multi-line text; y is the top of the first line.
const text = (content: string, x: number, y: number, size: number, color = BLACK, anchor: "start" | "middle" = "start") => {
  content.split("\n").forEach((line, index) => {
    parts.push(`<text x="${x}" y="${y + size * (1.25 * index + 1)}" font-size="${size}" fill="${color}" text-anchor="${anchor}">${escape(line)}</text>`)
  })
}

const rect = (x: number, y: number, width: number, height: number, stroke: Stroke): Box => {
  parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="16" fill="none" ${strokeAttributes(stroke)}/>`)
  return { x, y, width, height }
}

// A box with its label centered inside.
const box = (label: string, x: number, y: number, width: number, height: number, style: BoxStyle = {}): Box => {
  const size = style.size ?? 22
  const lines = label.split("\n").length
  text(label, x + width / 2, y + height / 2 - (lines * size * 1.25) / 2, size, BLACK, "middle")
  return rect(x, y, width, height, style)
}

const zone = (label: string, x: number, y: number, width: number, height: number) => {
  rect(x, y, width, height, { color: GRAY, dashed: true, width: 1 })
  text(label, x + 14, y + 10, 18, GRAY)
}

// A line with a filled head drawn at (x2, y2); resvg does not color markers by the line's stroke.
const arrow = (x1: number, y1: number, x2: number, y2: number, stroke: Stroke = {}) => {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const length = 16
  const base = (side: number) => `${x2 - length * Math.cos(angle + side * 0.4)},${y2 - length * Math.sin(angle + side * 0.4)}`
  parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2 - 10 * Math.cos(angle)}" y2="${y2 - 10 * Math.sin(angle)}" ${strokeAttributes(stroke)}/>`)
  parts.push(`<polygon points="${x2},${y2} ${base(1)} ${base(-1)}" fill="${stroke.color ?? BLACK}"/>`)
}

const rightOf = (b: Box, dy = 0) => [b.x + b.width, b.y + b.height / 2 + dy] as const
const leftOf = (b: Box) => [b.x, b.y + b.height / 2] as const
const link = (from: Box, to: Box, stroke: Stroke = {}) => arrow(...rightOf(from), ...leftOf(to), stroke)
const upInto = (from: Box, to: Box, stroke: Stroke) => arrow(from.x + from.width / 2, from.y, to.x + to.width / 2, to.y + to.height, stroke)

const KEY: Stroke = { color: RED, width: 3 }

// Columns shared by both rows so the two flows line up.
const AGENT_ZONE = { x: 30, width: 400 }
const PROXY_ZONE = { x: 660, width: 860 }
const NET_ZONE = { x: 1580, width: 380 }
const COLUMN = { network: 465, server: 690, middle: 900, decision: 1130, side: 1340 }
const BOX_HEIGHT = 110

const zones = (y: number, height: number) => {
  zone("agent machine", AGENT_ZONE.x, y, AGENT_ZONE.width, height)
  zone("proxy machine", PROXY_ZONE.x, y, PROXY_ZONE.width, height)
  zone("internet", NET_ZONE.x, y, NET_ZONE.width, height)
}

const typedProxy = (top: number) => {
  text("Typed proxy: one endpoint per API", 30, top, 34, GREEN)
  zones(top + 60, 380)
  const y = top + 130
  const agent = box("Agent\nclient.genImage(prompt)", 60, y, 340, BOX_HEIGHT)
  text("no key here", 60, y + BOX_HEIGHT + 20, 20, GRAY)
  const tailscale = box("Tailscale\nauth + HTTPS", COLUMN.network, y, 170, BOX_HEIGHT, { color: BLUE })
  const server = box("Server", COLUMN.server, y, 170, BOX_HEIGHT)
  text("No impersonation: two ordinary HTTPS\nconnections. Agent to proxy uses Tailscale's\nreal cert; proxy to OpenAI uses OpenAI's.", COLUMN.server, y + BOX_HEIGHT + 40, 17, GRAY)
  const method = box("Typed method\nURL fixed\nin code", COLUMN.decision, y, 190, BOX_HEIGHT, { color: ORANGE })
  text("destination chosen here", COLUMN.decision - 10, y - 34, 18, ORANGE)
  const secrets = box("Secret store", COLUMN.decision, y + 190, 190, 80)
  const openai = box("api.openai.com", NET_ZONE.x + 60, y, 260, BOX_HEIGHT)
  text("only one way out", openai.x + 20, y + BOX_HEIGHT + 20, 20, GRAY)

  link(agent, tailscale)
  link(tailscale, server)
  link(server, method)
  link(method, openai, KEY)
  text("+ API key", method.x + method.width + 30, y + BOX_HEIGHT / 2 - 34, 18, RED)
  upInto(secrets, method, KEY)
}

const agentVault = (top: number) => {
  text("Agent Vault: generic HTTPS proxy", 30, top, 34, BLUE)
  zones(top + 60, 420)
  const y = top + 150
  const agent = box("Agent\ncalls api.openai.com", 60, y, 340, BOX_HEIGHT, { color: ORANGE })
  text("destination chosen here", 60, y - 34, 18, ORANGE)
  box("trusts vault CA", 60, y + 170, 200, 60, { color: PURPLE, dashed: true, size: 18 })
  text("no key here", 60, y + 260, 20, GRAY)
  const proxyEnv = box("HTTPS_PROXY\n+ vault token", COLUMN.network - 15, y, 200, BOX_HEIGHT, { color: BLUE })
  const server = box("Server", COLUMN.server, y, 170, BOX_HEIGHT)
  const tls = box("TLS intercept\nfake cert\nfrom vault CA", COLUMN.middle, y, 190, BOX_HEIGHT, { color: PURPLE })
  text(
    "Why a fake cert? HTTPS is encrypted from the\nagent to api.openai.com, so a normal proxy\ncan't read or add headers. To insert the key,\nthe vault must pretend to be that site, and\nagents must trust its CA to accept it.",
    COLUMN.server,
    y + BOX_HEIGHT + 40,
    17,
    PURPLE
  )
  const rules = box("Config rules\nmatch host\nagainst table", COLUMN.decision, y, 190, BOX_HEIGHT)
  const secrets = box("Secret store", COLUMN.decision, y + 190, 190, 80)
  const noMatch = box("no match:\nforward without key\n(default) or 403", COLUMN.side, y + 175, 170, 110, { dashed: true, size: 17 })

  link(agent, proxyEnv)
  link(proxyEnv, server)
  link(server, tls)
  link(tls, rules)
  upInto(secrets, rules, KEY)
  arrow(rules.x + rules.width, rules.y + rules.height - 15, noMatch.x + noMatch.width / 2, noMatch.y, { color: GRAY, dashed: true })

  // Any host the agent names can receive a key, so the last hop fans out.
  const hosts = ["api.openai.com", "api.github.com", "api.stripe.com", "…any host"]
  const hostHeight = 62
  const hostStep = 80
  const hostsTop = y + BOX_HEIGHT / 2 - (hosts.length * hostStep - (hostStep - hostHeight)) / 2 + 40
  hosts.forEach((host, index) => {
    const target = box(host, NET_ZONE.x + 60, hostsTop + index * hostStep, 260, hostHeight, { size: 20, dashed: index === hosts.length - 1 })
    arrow(...rightOf(rules, index * 12 - 20), ...leftOf(target), KEY)
  })
  text("+ API key", rules.x + rules.width + 40, y - 30, 18, RED)
}

const legend = (y: number) => {
  arrow(30, y + 12, 110, y + 12, KEY)
  text("the API key travels here", 125, y, 20, RED)
  rect(450, y, 40, 26, { color: ORANGE })
  text("the destination is chosen here", 505, y, 20, ORANGE)
  rect(900, y, 40, 26, { color: BLUE })
  text("how the agent reaches the proxy", 955, y, 20, BLUE)
  rect(1350, y, 40, 26, { color: PURPLE })
  text("only needed to intercept HTTPS", 1405, y, 20, PURPLE)
}

const TRADE_OFFS: ReadonlyArray<readonly [string, string, string]> = [
  ["Flexibility", "Any SDK, CLI or API, added by config", "Typed client only; each API is server code"],
  ["HTTPS", "Impersonates every site: own CA, fake certs", "Two ordinary connections, real certs"],
  ["What can go wrong", "Rules too broad, unknown hosts allowed", "Little to configure, so little to get wrong"],
  ["Lines of code", "~32,700 Go", "~250 TypeScript"],
  ["Best for", "Teams, many APIs, tools you don't control", "One person, a few APIs, your own code"],
]

const tradeOffs = (top: number) => {
  text("Trade-offs", 30, top, 34, BLACK)
  const columns = [30, 330, 1150] as const
  const rowHeight = 56
  const headerY = top + 70
  text("Agent Vault", columns[1], headerY, 24, BLUE)
  text("Typed proxy", columns[2], headerY, 24, GREEN)
  TRADE_OFFS.forEach((row, index) => {
    const y = headerY + rowHeight * (index + 1)
    parts.push(`<line x1="30" y1="${y - 14}" x2="1960" y2="${y - 14}" stroke="#dee2e6" stroke-width="1"/>`)
    text(row[0], columns[0], y, 22, GRAY)
    text(row[1], columns[1], y, 22)
    text(row[2], columns[2], y, 22)
  })
}

agentVault(40)
typedProxy(600)
legend(1080)
tradeOffs(1180)

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="Liberation Sans, Nimbus Sans, Arial, DejaVu Sans, sans-serif">
<rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>
${parts.join("\n")}
</svg>`

await Bun.write(OUTPUT, new Resvg(svg, { font: { defaultFontFamily: "Liberation Sans" } }).render().asPng())
console.log(`wrote ${OUTPUT}`)
