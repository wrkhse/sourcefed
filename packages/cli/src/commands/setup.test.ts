import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { parseSetupArgs } from "./setup.ts"

describe("parseSetupArgs", () => {
  test("sets up every host, with the default name, when no arguments are given", () => {
    assert.deepEqual(parseSetupArgs([]), { target: "all", name: "chauffeur-next" })
  })

  test("reads one target and keeps the default name", () => {
    assert.deepEqual(parseSetupArgs(["opencode"]), { target: "opencode", name: "chauffeur-next" })
    assert.deepEqual(parseSetupArgs(["pi"]), { target: "pi", name: "chauffeur-next" })
    assert.deepEqual(parseSetupArgs(["chauffeur"]), { target: "chauffeur", name: "chauffeur-next" })
  })

  test("reads the Chauffeur name in both spellings", () => {
    assert.deepEqual(parseSetupArgs(["chauffeur", "--name", "chauffeur"]), { target: "chauffeur", name: "chauffeur" })
    assert.deepEqual(parseSetupArgs(["chauffeur", "--name=chauffeur"]), { target: "chauffeur", name: "chauffeur" })
  })

  test("names the allowed targets when the target is missing or unknown", () => {
    const expected = "unknown setup target --name; expected opencode, pi or chauffeur (sourcefed setup chauffeur --name chauffeur)"

    assert.deepEqual(parseSetupArgs(["--name", "chauffeur"]), { error: expected })
    assert.deepEqual(parseSetupArgs(["paste"]), {
      error: "unknown setup target paste; expected opencode, pi or chauffeur (sourcefed setup chauffeur --name chauffeur)",
    })
  })

  test("rejects a --name without a value and a --name outside the allowed names", () => {
    for (const args of [["chauffeur", "--name"], ["chauffeur", "--name="], ["chauffeur", "--name", "chauffeur-9"]]) {
      const parsed = parseSetupArgs(args)

      assert.ok("error" in parsed, args.join(" "))
      assert.match(parsed.error, /chauffeur-next or chauffeur/)
    }
  })

  test("rejects --name with another target", () => {
    for (const args of [["opencode", "--name", "chauffeur"], ["all", "--name=chauffeur"], ["pi", "--name", "chauffeur-next"]]) {
      const parsed = parseSetupArgs(args)

      assert.ok("error" in parsed, args.join(" "))
      assert.match(parsed.error, /only valid with the chauffeur target/)
    }
  })
})
