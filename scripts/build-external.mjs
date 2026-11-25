// What the two esbuild builds leave out: the published bundle (scripts/build-public.mjs) and
// the test bundles (scripts/build-tests.mjs). node:* is never bundled; the MCP server and the
// OpenCode plugin are regular dependencies the published package resolves at runtime; the
// three Pi packages are optional peers the host supplies.
export const EXTERNAL = [
  "node:*",
  "@modelcontextprotocol/server",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
  "@opencode/plugin",
  "@opencode/plugin/*",
];
