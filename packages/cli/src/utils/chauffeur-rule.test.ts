import assert from "node:assert/strict"
import { after, describe, test } from "node:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import os from "node:os"
import path from "node:path"
import { chauffeurSocket } from "@sourcefed/daemon"
import { CHAUFFEUR_NAMES, TRIAGE_RULE, installTriageRule, triageRulePath } from "./chauffeur-rule.ts"

const directories: string[] = []
const servers = new Set<Server>()
const connections = new Set<Socket>()

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sf-"))
  directories.push(directory)
  return directory
}

function environment(): { XDG_CONFIG_HOME: string; XDG_RUNTIME_DIR: string } {
  return { XDG_CONFIG_HOME: temporaryDirectory(), XDG_RUNTIME_DIR: temporaryDirectory() }
}

function statusServer(socket: string, version: string, protocol = 1): Promise<void> {
  mkdirSync(path.dirname(socket), { recursive: true })
  const server = createServer((connection) => {
    connections.add(connection)
    connection.on("close", () => connections.delete(connection))
    connection.on("error", () => {})
    connection.setEncoding("utf8")

    let pending = ""
    connection.on("data", (chunk: Buffer | string) => {
      pending += chunk.toString()
      if (pending.indexOf("\n") === -1) return

      const reply = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { version, protocol } })
      connection.write(`${reply}\n`)
    })
  })
  servers.add(server)
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, () => {
      server.off("error", reject)
      resolve()
    })
  })
}

after(async () => {
  for (const connection of connections) connection.destroy()
  connections.clear()
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("triageRulePath", () => {
  test("uses XDG_CONFIG_HOME when it is set", () => {
    assert.equal(
      triageRulePath("chauffeur-next", { XDG_CONFIG_HOME: "/cfg" }),
      "/cfg/chauffeur-next/rules/sourcefed/triage.json",
    )
  })

  test("falls back to ~/.config when XDG_CONFIG_HOME is unset or empty", () => {
    const expected = path.join(os.homedir(), ".config", "chauffeur", "rules", "sourcefed", "triage.json")

    assert.equal(triageRulePath("chauffeur", {}), expected)
    assert.equal(triageRulePath("chauffeur", { XDG_CONFIG_HOME: "" }), expected)
  })
})

describe("installTriageRule", () => {
  test("writes the canonical rule for chauffeur-next", async () => {
    const env = environment()
    const result = await installTriageRule({ name: "chauffeur-next", env })

    assert.equal(result.status, "written")
    assert.equal(result.path, path.join(env.XDG_CONFIG_HOME, "chauffeur-next", "rules", "sourcefed", "triage.json"))
    assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")), TRIAGE_RULE)
    assert.equal(statSync(result.path).mode & 0o777, 0o644)
  })

  test("a second install keeps a user-edited file byte for byte", async () => {
    const env = environment()
    const first = await installTriageRule({ name: "chauffeur-next", env })
    assert.equal(first.status, "written")

    writeFileSync(first.path, "{\"edited\":true}\n")
    const second = await installTriageRule({ name: "chauffeur-next", env })

    assert.equal(second.status, "present")
    assert.equal(readFileSync(second.path, "utf8"), "{\"edited\":true}\n")
  })

  test("refuses the chauffeur name when no v2 daemon answers", async () => {
    const env = environment()
    const result = await installTriageRule({ name: "chauffeur", env })

    assert.equal(result.status, "refused")
    assert.ok(result.reason?.startsWith(`no Chauffeur v2 answers on ${chauffeurSocket("chauffeur", env)}`), result.reason ?? "")
    assert.equal(existsSync(path.join(env.XDG_CONFIG_HOME, "chauffeur")), false)
    assert.equal(existsSync(triageRulePath("chauffeur", env)), false)
  })

  test("writes the chauffeur rule when a v2 daemon answers", async () => {
    const env = environment()
    await statusServer(chauffeurSocket("chauffeur", env), "1.0.0-rc.4")

    const result = await installTriageRule({ name: "chauffeur", env })

    assert.equal(result.status, "written")
    assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")), TRIAGE_RULE)
  })

  test("refuses the chauffeur name when a v1 daemon answers", async () => {
    const env = environment()
    await statusServer(chauffeurSocket("chauffeur", env), "0.1.0")

    const result = await installTriageRule({ name: "chauffeur", env })

    assert.equal(result.status, "refused")
    assert.equal(existsSync(triageRulePath("chauffeur", env)), false)
  })

  test("skips when the config folder must exist and does not", async () => {
    const env = environment()
    const result = await installTriageRule({ name: "chauffeur-next", env, requireConfigDir: true })

    assert.equal(result.status, "skipped")
    assert.ok(result.reason?.includes("does not exist"), result.reason ?? "")
    assert.equal(existsSync(path.join(env.XDG_CONFIG_HOME, "chauffeur-next")), false)
    assert.equal(existsSync(triageRulePath("chauffeur-next", env)), false)
  })

  test("throws for a name outside the allowed names", async () => {
    const env = environment()

    await assert.rejects(
      installTriageRule({ name: "chauffeur-9", env }),
      new RegExp(`allowed names: ${CHAUFFEUR_NAMES.join(", ")}`),
    )
  })
})
