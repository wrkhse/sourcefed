import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { MonitorEvent, MonitorRecord } from "@sourcefed/core"
import type { ChauffeurEndpoint } from "./discover.ts"
import { chauffeurNavigators, type ChauffeurConnect } from "./navigator.ts"
import { ChauffeurTriage, type Navigator } from "./triage.ts"

const endpoint: ChauffeurEndpoint = { socket: "/run/user/501/chauffeur-next/daemon.sock", version: "1.0.0-rc.5" }
const other: ChauffeurEndpoint = { socket: "/run/user/501/chauffeur/daemon.sock", version: "1.2.3" }

function monitorRecord(): MonitorRecord {
  return {
    id: "monitor-1",
    name: "test monitor",
    source: { type: "github", repo: "wrkhse/chauffeur", prNumber: 42 },
    delivery: "poll",
    target: { kind: "test", id: "session-1" },
    pollIntervalSec: 60,
    enabled: true,
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
    cursors: {},
  }
}

function monitorEvent(): MonitorEvent {
  return {
    source: { type: "github" },
    kind: "review",
    at: "2026-11-17T00:00:00.000Z",
    summary: "Changes requested on PR #42",
    actionable: true,
  }
}

function fakeNavigator(withhold = false) {
  let closes = 0
  const navigator: Navigator = {
    navigate: async () => ({ intents: withhold ? [{ rule: "sourcefed/triage", withhold: "event" }] : [] }),
    close: () => {
      closes += 1
    },
  }

  return { navigator, closeCount: () => closes }
}

describe("chauffeurNavigators", () => {
  test("gives the client the socket of the endpoint it was given", () => {
    const calls: Array<{ socket: string }> = []
    const connection = fakeNavigator()
    const connect: ChauffeurConnect = (options) => {
      calls.push(options)
      return connection.navigator
    }

    const navigator = chauffeurNavigators(connect)(endpoint)

    assert.deepEqual(calls, [{ socket: "/run/user/501/chauffeur-next/daemon.sock" }])
    assert.equal(navigator, connection.navigator)
  })

  test("opens one connection for each endpoint", () => {
    const sockets: string[] = []
    const connect: ChauffeurConnect = (options) => {
      sockets.push(options.socket)
      return fakeNavigator().navigator
    }
    const navigatorFor = chauffeurNavigators(connect)

    const first = navigatorFor(endpoint)
    const second = navigatorFor(other)

    assert.deepEqual(sockets, [endpoint.socket, other.socket])
    assert.notEqual(first, second)
  })

  test("drives a withhold from a client connection through ChauffeurTriage", async () => {
    const connection = fakeNavigator(true)
    const triage = new ChauffeurTriage({
      connect: chauffeurNavigators(() => connection.navigator),
      discover: async () => endpoint,
      deadlineMs: 50,
      log: () => {},
    })

    assert.deepEqual(await triage.decide(monitorRecord(), monitorEvent()), { deliver: false, rule: "sourcefed/triage" })

    triage.close()
    assert.equal(connection.closeCount(), 1)
  })
})
