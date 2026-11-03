import packageJson from "../package.json" with { type: "json" }

// The `version` of package.json, shared by the CLI and the deploy.
export const version: string = packageJson.version

// The commit of this checkout, `-dirty` with uncommitted changes, e.g. `04a40f3`: the deploy gives it to the Worker as
// PROXY_VERSION, which /health answers, and `bun run test:live` expects it there.
export const commitVersion = (): string => {
  const described = Bun.spawnSync(["git", "describe", "--always", "--dirty"], { cwd: import.meta.dir })
  if (described.exitCode !== 0) {
    throw new Error(`git describe failed in ${import.meta.dir}: ${described.stderr.toString().trim()}`)
  }
  return described.stdout.toString().trim()
}
