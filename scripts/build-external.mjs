// Packages every bundle leaves out: Node built-ins, plus the host-provided packages the
// published package declares as peers. Shared by the shipped build and the test build so a
// test resolves them from node_modules exactly as the shipped bundle does.
export const EXTERNAL = [
  "node:*",
  "@modelcontextprotocol/server",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
  "@opencode/plugin",
  "@opencode/plugin/*",
]
