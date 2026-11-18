import { build } from "esbuild"
import { redactHeaders, replyResponse } from "@sourcefed/sdk"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const [casesPath, ref] = process.argv.slice(2)

if (!casesPath || !ref) {
  throw new Error("usage: node scripts/record-golden.mjs <cases.json> <ref>")
}

const input = JSON.parse(readFileSync(path.resolve(root, casesPath), "utf8"))
const recordedFrom = git(["rev-parse", "--short=7", ref]).trim()
const temporary = mkdtempSync(path.join(os.tmpdir(), "sourcefed-golden-"))
const RealDate = Date

try {
  git(["worktree", "add", "--detach", temporary, ref])
  const bundle = await bundleProvider(temporary, input.entry)

  for (const [name, value] of Object.entries(input.env ?? {})) {
    process.env[name] = value
  }

  for (const name of input.unset ?? []) {
    delete process.env[name]
  }

  if (input.now) {
    // The pre-SDK providers stamp events with `new Date()` by default, so a reproducible
    // recording runs them at one fixed instant.
    const fixed = RealDate.parse(input.now)
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(fixed)
        else super(...args)
      }

      static now() {
        return fixed
      }
    }
  }

  const exported = (await import(pathToFileURL(bundle).href))[input.export]
  const monitor = typeof exported === "function" ? new exported() : exported
  const cases = []

  for (const kase of input.cases) {
    const previous = cases.at(-1)

    if (kase.continues && (!previous || "error" in previous || "deferred" in previous)) {
      throw new Error(`invalid continuation for ${kase.name}`)
    }

    // A first poll runs with an absent cursor, as the runtime gives it, and records `null`.
    // A continuing case whose previous cursor was `null` also runs with an absent cursor:
    // the store gives a poll an absent cursor, never `null`, and the replay applies the same rule.
    const cursor = kase.continues ? previous.cursorAfter ?? undefined : undefined
    cases.push(await recordCase(monitor, kase, cursor))
  }

  const fixture = { provider: input.provider, recordedFrom, base: input.base, ...(input.now ? { now: input.now } : {}), cases }
  const constant = input.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_GOLDEN"
  const header = `/** What the pre-SDK ${input.provider} provider did at ${recordedFrom}, recorded so the SDK port must reproduce it exactly. */`
  const text = `import type { GoldenFixture } from "@sourcefed/sdk"\n\n${header}\nexport const ${constant}: GoldenFixture = ${JSON.stringify(fixture, null, 2)}\n`
  writeFileSync(path.resolve(root, input.fixture), text)
  console.log(`${createHash("sha256").update(text).digest("hex")}  ${input.fixture}`)
} finally {
  globalThis.Date = RealDate

  try {
    git(["worktree", "remove", "--force", temporary])
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 60000 })
}

function workspaceManifests(worktree) {
  const manifests = []

  for (const directory of ["packages", "providers", "adapters"]) {
    const parent = path.join(worktree, directory)

    if (!existsSync(parent)) continue

    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue

      const base = path.join(parent, entry.name)
      const file = path.join(base, "package.json")

      if (existsSync(file)) {
        manifests.push({ ...JSON.parse(readFileSync(file, "utf8")), base })
      }
    }
  }

  return manifests
}

async function bundleProvider(worktree, entry) {
  const workspaces = workspaceManifests(worktree)
  const defineFile = path.join(worktree, "scripts/build-define.mjs")
  const define = existsSync(defineFile) ? (await import(pathToFileURL(defineFile).href)).define : {}
  const outfile = path.join(worktree, "golden.mjs")

  await build({
    absWorkingDir: worktree,
    entryPoints: [path.join(worktree, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["node:*"],
    write: true,
    logLevel: "warning",
    define,
    nodePaths: [path.join(root, "node_modules")],
    plugins: [{
      name: "recorded-workspaces",
      setup(builder) {
        builder.onResolve({ filter: /^@sourcefed\// }, ({ path: specifier }) => {
          const workspace = workspaces.find((item) => specifier === item.name || specifier.startsWith(item.name + "/"))

          if (!workspace) throw new Error(`unknown workspace ${specifier}`)

          const subpath = "." + specifier.slice(workspace.name.length)
          const exported = workspace.exports[subpath]
          const target = typeof exported === "string" ? exported : exported?.types

          if (!target) throw new Error(`missing type export for ${specifier}`)

          return { path: path.join(workspace.base, target) }
        })
      },
    }],
  })

  return outfile
}

async function recordCase(monitor, kase, cursor) {
  const requests = []
  const originalFetch = globalThis.fetch
  let next = 0

  globalThis.fetch = async (input, init) => {
    requests.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers: redactHeaders(init?.headers),
    })

    const reply = kase.replies[next]
    next += 1

    if (!reply) throw new Error(`no golden reply for ${String(input)}`)

    return replyResponse(reply)
  }

  try {
    const source = monitor.validateSource(monitor.build(kase.build))
    const recorded = {
      name: kase.name,
      build: kase.build,
      cursor: cursor ?? null,
      replies: kase.replies,
      requests,
      source,
      key: monitor.key(source),
      label: monitor.label(source),
      detail: monitor.detail(source),
      describe: monitor.describe(source),
      icon: monitor.icon,
      schema: monitor.input,
    }

    try {
      // TypeScript privacy does not exist at runtime. Calling the private runner
      // records the old provider's return value without reimplementing its poll monitor.
      const result = await monitor.poll.options.run(source, cursor, "golden")

      if ("deferred" in result) return { ...recorded, deferred: true }

      return {
        ...recorded,
        events: asJSON(result.events),
        cursorAfter: asJSON(result.cursor),
        terminal: asJSON(result.terminal ?? false),
      }
    } catch (error) {
      return { ...recorded, error: error.message }
    }
  } finally {
    globalThis.fetch = originalFetch
  }
}

function asJSON(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}
