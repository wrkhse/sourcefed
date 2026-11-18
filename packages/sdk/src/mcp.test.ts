import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, mock, test } from "node:test"
import { fakeMcpSpawn, hostMcpServers, McpError, stdioMcp, type GoldenMcpCall, type McpChild, type McpSpawn } from "@sourcefed/sdk"

const server = { command: "fake-server", args: ["mcp", "--quiet"], timeoutMs: 45_000 }

/**
 * A child that records what the client wrote and answers only what the test scripts. By default
 * it exits on SIGTERM, as a well-behaved server does; "ignore-term" exits only on SIGKILL, and
 * "never" does not exit at all.
 */
function handChild(onKill: "exit" | "ignore-term" | "never" = "exit") {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const written: any[] = []
  const signals: Array<NodeJS.Signals | undefined> = []
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: (signal?: NodeJS.Signals) => {
      signals.push(signal)
      if (onKill === "exit" || (onKill === "ignore-term" && signal === "SIGKILL")) child.emit("exit", null)
    },
  })

  stdin.setEncoding("utf8")
  stdin.on("data", (chunk: string) => {
    for (const line of chunk.split("\n").filter(Boolean)) written.push(JSON.parse(line))
  })

  return { child, written, signals, kills: () => signals.length, say: (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`) }
}

function spawnOnce(child: McpChild, seen: Array<[string, readonly string[]]> = []): McpSpawn {
  return (command, args) => {
    seen.push([command, args])
    return child
  }
}

const tick = () => new Promise((resolve) => process.nextTick(resolve))

describe("stdioMcp", () => {
  test("answers the tool's text after initialize, initialized and tools/call", async () => {
    const hand = handChild()
    const seen: Array<[string, readonly string[]]> = []
    const mcp = stdioMcp((name) => (name === "yab" ? server : undefined), spawnOnce(hand.child, seen))

    const answer = mcp.call("yab", "fetch", { url: "https://fake.test/feed" })
    await tick()
    hand.say({ jsonrpc: "2.0", id: 1, result: {} })
    await tick()
    hand.say({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }] } })

    assert.equal(await answer, "one\ntwo")
    assert.deepEqual(seen, [["fake-server", ["mcp", "--quiet"]]])
    assert.deepEqual(hand.written, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sourcefed", version: "0.3" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch", arguments: { url: "https://fake.test/feed" } } },
    ])
    assert.equal(hand.kills(), 1)
  })

  test("skips lines that are not JSON", async () => {
    const hand = handChild()
    const mcp = stdioMcp(() => server, spawnOnce(hand.child))

    const answer = mcp.call("yab", "fetch", {})
    await tick()
    hand.child.stdout.write("starting up\n\n")
    hand.say({ jsonrpc: "2.0", id: 1, result: {} })
    await tick()
    hand.child.stdout.write("{not json\n")
    hand.say({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } })

    assert.equal(await answer, "ok")
  })

  test("runs against the golden fake server and records the call", async () => {
    const calls: GoldenMcpCall[] = []
    const spawn = fakeMcpSpawn([{ text: "page" }], calls)
    const mcp = stdioMcp(() => server, spawn)

    assert.equal(await mcp.call("yab", "fetch", { url: "u" }), "page")
    assert.deepEqual(calls, [{ tool: "fetch", arguments: { url: "u" } }])
    assert.equal(spawn.missing, false)
  })

  test("a spawn that throws is a start failure naming the command", async () => {
    const mcp = stdioMcp(() => server, () => {
      throw new Error("ENOENT")
    })

    await assert.rejects(mcp.call("yab", "fetch", {}), (error: McpError) => {
      assert.equal(error.failure, "start")
      assert.equal(error.message, "yab could not start (fake-server)")
      assert.equal(error.command, "fake-server")
      return true
    })
  })

  test("a child that emits error is a start failure", async () => {
    const hand = handChild()
    const mcp = stdioMcp(() => server, spawnOnce(hand.child))

    const answer = mcp.call("yab", "fetch", {})
    hand.child.emit("error", new Error("ENOENT"))

    await assert.rejects(answer, { failure: "start", command: "fake-server" })
    assert.equal(hand.kills(), 1)
  })

  test("an exit before answering keeps stderr in detail, out of the message", async () => {
    const hand = handChild()
    const mcp = stdioMcp(() => server, spawnOnce(hand.child))

    const answer = mcp.call("yab", "fetch", { url: "https://fake.test/secret-feed" })
    hand.child.stderr.write("cannot read https://fake.test/secret-feed")
    await tick()
    hand.child.emit("exit", 3)

    await assert.rejects(answer, (error: McpError) => {
      assert.equal(error.failure, "exit")
      assert.equal(error.exitCode, 3)
      assert.equal(error.detail, "cannot read https://fake.test/secret-feed")
      assert.equal(error.message, "yab exited (3) before answering")
      return true
    })
  })

  test("a JSON-RPC error carries its code", async () => {
    const calls: GoldenMcpCall[] = []
    const mcp = stdioMcp(() => server, fakeMcpSpawn([{ error: { code: -32602, message: "bad url https://fake.test/x" } }], calls))

    await assert.rejects(mcp.call("yab", "fetch", {}), (error: McpError) => {
      assert.equal(error.failure, "error")
      assert.equal(error.code, -32602)
      assert.equal(error.message, "yab answered with an error (code -32602)")
      assert.equal(error.detail, "bad url https://fake.test/x")
      return true
    })
  })

  test("a tool failure keeps the tool's text in detail", async () => {
    const calls: GoldenMcpCall[] = []
    const mcp = stdioMcp(() => server, fakeMcpSpawn([{ text: "no such page", isError: true }], calls))

    await assert.rejects(mcp.call("yab", "fetch", {}), (error: McpError) => {
      assert.equal(error.failure, "tool")
      assert.equal(error.message, "yab reported the fetch failed")
      assert.equal(error.detail, "no such page")
      return true
    })
  })

  test("a server that does not answer in timeoutMs times out", async () => {
    mock.timers.enable({ apis: ["setTimeout"] })

    try {
      const hand = handChild()
      const mcp = stdioMcp(() => ({ ...server, timeoutMs: 2_000 }), spawnOnce(hand.child))

      const answer = mcp.call("yab", "fetch", {})
      mock.timers.tick(2_000)

      await assert.rejects(answer, (error: McpError) => {
        assert.equal(error.failure, "timeout")
        assert.equal(error.message, "yab did not answer in 2 s")
        assert.equal(error.timeoutMs, 2_000)
        return true
      })
      assert.equal(hand.kills(), 1)
    } finally {
      mock.timers.reset()
    }
  })

  test("settles once and kills the child once", async () => {
    const hand = handChild()
    const mcp = stdioMcp(() => server, spawnOnce(hand.child))

    const answer = mcp.call("yab", "fetch", {})
    hand.child.emit("exit", 1)
    hand.child.emit("error", new Error("late"))

    await assert.rejects(answer, { failure: "exit" })
    // It had already exited, so there is nothing to stop.
    assert.equal(hand.kills(), 0)
  })

  test("parses an answer split mid-line across two chunks", async () => {
    const hand = handChild()
    const mcp = stdioMcp(() => server, spawnOnce(hand.child))

    const answer = mcp.call("yab", "fetch", {})
    await tick()
    hand.say({ jsonrpc: "2.0", id: 1, result: {} })
    await tick()
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "whole" }] } })}\n`
    hand.child.stdout.write(line.slice(0, 20))
    await tick()
    hand.child.stdout.write(line.slice(20))

    assert.equal(await answer, "whole")
  })

  test("more than 16 MiB without a newline is an overflow", async () => {
    const hand = handChild()
    const mcp = stdioMcp(() => server, spawnOnce(hand.child))

    const answer = mcp.call("yab", "fetch", {})
    const mib = "x".repeat(1024 * 1024)
    for (let i = 0; i <= 16; i += 1) hand.child.stdout.write(mib)

    await assert.rejects(answer, (error: McpError) => {
      assert.equal(error.failure, "overflow")
      assert.equal(error.message, "yab answered more than 16 MiB")
      assert.equal(error.limitBytes, 16 * 1024 * 1024)
      return true
    })
  })

  test("keeps only the first 4096 characters of stderr", async () => {
    const hand = handChild()
    const mcp = stdioMcp(() => server, spawnOnce(hand.child))
    const written = Array.from({ length: 10_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("")

    const answer = mcp.call("yab", "fetch", {})
    hand.child.stderr.write(written.slice(0, 3_000))
    hand.child.stderr.write(written.slice(3_000))
    await tick()
    hand.child.emit("exit", 3)

    await assert.rejects(answer, (error: McpError) => {
      assert.equal(error.detail.length, 4096)
      assert.equal(error.detail, written.slice(0, 4096))
      return true
    })
  })

  describe("stopping the child", () => {
    const answered = async (hand: ReturnType<typeof handChild>) => {
      await tick()
      hand.say({ jsonrpc: "2.0", id: 1, result: {} })
      await tick()
      hand.say({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } })
      await tick()
    }
    const watch = (answer: Promise<string>) => {
      const state = { settled: false }
      answer.then(() => (state.settled = true), () => (state.settled = true))
      return state
    }

    test("a child that ignores SIGTERM gets SIGKILL after 2 s and the call settles on its exit", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] })
      const hand = handChild("ignore-term")
      const answer = stdioMcp(() => server, spawnOnce(hand.child)).call("yab", "fetch", {})
      const state = watch(answer)

      await answered(hand)
      assert.deepEqual(hand.signals, ["SIGTERM"])
      assert.equal(state.settled, false)

      t.mock.timers.tick(1_999)
      await tick()
      assert.deepEqual(hand.signals, ["SIGTERM"])

      t.mock.timers.tick(1)
      assert.equal(await answer, "ok")
      assert.deepEqual(hand.signals, ["SIGTERM", "SIGKILL"])
    })

    test("a child that never exits: the call settles 2 s after SIGKILL anyway", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] })
      const hand = handChild("never")
      const answer = stdioMcp(() => server, spawnOnce(hand.child)).call("yab", "fetch", {})
      const state = watch(answer)

      await answered(hand)
      t.mock.timers.tick(2_000)
      await tick()
      assert.deepEqual(hand.signals, ["SIGTERM", "SIGKILL"])

      t.mock.timers.tick(1_999)
      await tick()
      assert.equal(state.settled, false)

      t.mock.timers.tick(1)
      assert.equal(await answer, "ok")
    })

    test("a child that exits on SIGTERM gets no SIGKILL, and no timer is left", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] })
      const hand = handChild()
      const answer = stdioMcp(() => server, spawnOnce(hand.child)).call("yab", "fetch", {})

      await answered(hand)
      assert.equal(await answer, "ok")

      t.mock.timers.tick(10 * 60_000)
      await tick()
      assert.deepEqual(hand.signals, ["SIGTERM"])
    })

    test("no timer outlives a call whose child needed SIGKILL", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] })
      const hand = handChild("ignore-term")
      let exits = 0
      hand.child.on("exit", () => (exits += 1))
      const answer = stdioMcp(() => server, spawnOnce(hand.child)).call("yab", "fetch", {})

      await answered(hand)
      t.mock.timers.tick(2_000)
      assert.equal(await answer, "ok")

      t.mock.timers.tick(10 * 60_000)
      await tick()
      assert.deepEqual(hand.signals, ["SIGTERM", "SIGKILL"])
      assert.equal(exits, 1)
    })
  })

  test("an unknown server rejects with a plain error naming it", async () => {
    const mcp = stdioMcp(() => undefined, () => assert.fail("no process for an unknown server"))

    await assert.rejects(mcp.call("nope", "fetch", {}), (error: Error) => {
      assert.equal(error instanceof McpError, false)
      assert.equal(error.message, "no MCP server named nope")
      return true
    })
  })
})

describe("hostMcpServers", () => {
  test("runs yab from SOURCEFED_YAB_COMMAND, read at each call", () => {
    const previous = process.env.SOURCEFED_YAB_COMMAND

    try {
      delete process.env.SOURCEFED_YAB_COMMAND
      assert.deepEqual(hostMcpServers("yab"), { command: "/Applications/yab.app/Contents/MacOS/yab", args: ["mcp"], timeoutMs: 45_000 })

      process.env.SOURCEFED_YAB_COMMAND = "/tmp/fake-yab"
      assert.equal(hostMcpServers("yab")?.command, "/tmp/fake-yab")
      assert.equal(hostMcpServers("other"), undefined)
    } finally {
      if (previous === undefined) delete process.env.SOURCEFED_YAB_COMMAND
      else process.env.SOURCEFED_YAB_COMMAND = previous
    }
  })
})
