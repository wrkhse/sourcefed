import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { connect } from "@fdcn/chauffeur/client";
import {
  InMemoryMonitorEventQueue,
  InMemoryMonitorStore,
  type MonitorEvent,
  type MonitorRecord,
  type MonitorTarget,
  type QueuedMonitorEvent,
} from "@sourcefed/core";
import {
  ChauffeurTriage,
  SourcefedDaemon,
  chauffeurNavigators,
  chauffeurSocket,
  probeChauffeur,
} from "@sourcefed/daemon";
import { installTriageRule, triageRulePath } from "./chauffeur-rule.ts";
import { createDaemon } from "./daemon.ts";

/**
 * The contract with a real Chauffeur daemon: the rule setup writes is the rule the daemon
 * loads, and the sink does what its verdicts say. It starts a process, so it runs only where
 * CHAUFFEUR_BIN names a v2 binary; CI fetches one and a developer's machine has none.
 */

const BIN = process.env.CHAUFFEUR_BIN;
const target: MonitorTarget = { kind: "test", id: "session-1" };

/** Node's test runner has no describe.skipIf, so every daemon test carries this mark. */
const noDaemon = BIN === undefined;

/** How long the real daemon gets to answer a probe after it is spawned. */
const READY_MS = 20_000;
const STEP_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** The queue's events once it holds `count`, or a failed test rather than a hang. */
async function waitForEvents(
  daemon: SourcefedDaemon,
  count: number,
  ms = 2_000,
): Promise<QueuedMonitorEvent[]> {
  const deadline = Date.now() + ms;

  for (;;) {
    const queued = await daemon.readEvents(target);
    if (queued.length >= count) return queued;
    if (Date.now() >= deadline)
      throw new Error(
        `the queue held ${queued.length} events after ${ms}ms, expected ${count}`,
      );
    await sleep(STEP_MS);
  }
}

/** The models one phase loads: a placeholder that answers `answer` confidently. */
function modelsJSON(answer: "yes" | "no"): string {
  const otherwise =
    answer === "yes" ? { yes: 0.94, no: 0.06 } : { yes: 0.06, no: 0.94 };

  return `${JSON.stringify(
    {
      models: { stand_in: { format: "placeholder", otherwise } },
      tiers: { "system-one": ["stand_in"], "system-two": ["stand_in"] },
    },
    null,
    2,
  )}\n`;
}

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
  };
}

function commentEvent(): MonitorEvent {
  return {
    source: { type: "github" },
    kind: "comment",
    id: "comment:1",
    at: "2026-11-17T00:00:00.000Z",
    summary: "Comment on PR #42",
    actionable: true,
  };
}

describe("the sourcefed/triage contract", () => {
  test("the workflow that requires a daemon provides one", () => {
    // Only the workflow that sets CHAUFFEUR_REQUIRED must supply CHAUFFEUR_BIN: a renamed job
    // cannot make this contract skip silently, and a daemon-less check keeps working elsewhere.
    if (process.env.CHAUFFEUR_REQUIRED)
      assert.ok(
        BIN,
        "CHAUFFEUR_REQUIRED is set, so CHAUFFEUR_BIN must name the fetched Chauffeur daemon",
      );
  });

  describe("with a real daemon", () => {
    let root = "";
    let binary = "";
    let config = "";
    let state = "";
    let distribution = "";
    let child: ChildProcess | undefined;
    let phase = 0;
    let running: "yes" | "no" | undefined;
    let runtime: string | undefined;
    let socketVariable: string | undefined;

    before(() => {
      // Nothing is prepared when every daemon test below is skipped.
      if (noDaemon) return;

      root = mkdtempSync(join(tmpdir(), "sourcefed-chauffeur-"));
      config = join(root, "config");
      state = join(root, "state");
      distribution = resolve(dirname(BIN ?? ""), "..", "share", "chauffeur");
      // The daemon's name is its executable's, so this install is chauffeur-next.
      binary = join(root, "bin", "chauffeur-next");
      mkdirSync(dirname(binary), { recursive: true });
      copyFileSync(BIN ?? "", binary);
      chmodSync(binary, 0o755);
      socketVariable = process.env.CHAUFFEUR_SOCKET;
      runtime = process.env.XDG_RUNTIME_DIR;
      // Discovery must find the daemon the way production does, never through this override.
      delete process.env.CHAUFFEUR_SOCKET;
    });

    after(async () => {
      if (noDaemon) return;

      await stopDaemon();
      if (socketVariable === undefined) delete process.env.CHAUFFEUR_SOCKET;
      else process.env.CHAUFFEUR_SOCKET = socketVariable;
      if (runtime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = runtime;
      rmSync(root, { recursive: true, force: true });
    });

    test(
      "setup writes the rule where the daemon reads it",
      { skip: noDaemon },
      async () => {
        // installTriageRule is what `sourcefed setup chauffeur` runs; the daemon reads <config>/<name>/rules.
        const install = await installTriageRule({
          name: "chauffeur-next",
          env: { XDG_CONFIG_HOME: config },
        });
        assert.equal(install.status, "written");
        assert.ok(
          existsSync(
            triageRulePath("chauffeur-next", { XDG_CONFIG_HOME: config }),
          ),
        );
      },
    );

    test(
      "the rule withholds the event its judge refuses",
      { skip: noDaemon },
      async () => {
        await startDaemon("no");
        const triage = new ChauffeurTriage({
          connect: chauffeurNavigators(connect),
          log: () => {},
        });
        try {
          assert.deepEqual(
            await triage.decide(monitorRecord(), commentEvent()),
            { deliver: false, rule: "sourcefed/triage" },
          );
        } finally {
          triage.close();
        }
      },
    );

    test(
      "the sink queues nothing for the event the daemon withholds",
      { skip: noDaemon },
      async () => {
        await startDaemon("no");
        const daemon = createDaemon({
          store: new InMemoryMonitorStore(),
          eventQueue: new InMemoryMonitorEventQueue(),
          stateDir: state,
        });
        try {
          assert.deepEqual(
            await daemon.runtime.context.sink.deliver({
              monitor: monitorRecord(),
              event: commentEvent(),
            }),
            { ok: true },
          );
          assert.deepEqual(await daemon.readEvents(target), []);
        } finally {
          await daemon.stop();
        }
      },
    );

    test(
      "the sink queues the event the daemon allows, marked triaged",
      { skip: noDaemon },
      async () => {
        await startDaemon("yes");
        const daemon = createDaemon({
          store: new InMemoryMonitorStore(),
          eventQueue: new InMemoryMonitorEventQueue(),
          stateDir: state,
        });
        try {
          assert.deepEqual(
            await daemon.runtime.context.sink.deliver({
              monitor: monitorRecord(),
              event: commentEvent(),
            }),
            { ok: true },
          );
          const queued = await waitForEvents(daemon, 1);
          assert.equal(queued.length, 1);
          assert.equal(queued[0].chauffeurTriaged, true);
        } finally {
          await daemon.stop();
        }
      },
    );

    /** Starts the daemon for `answer`, in a runtime folder of its own, unless that phase already runs. */
    async function startDaemon(answer: "yes" | "no"): Promise<void> {
      if (running === answer) return;
      await stopDaemon();

      // Each phase gets its own runtime folder, so a restarted daemon never meets a stale socket.
      phase += 1;
      const directory = join(root, `run-${phase}`);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      process.env.XDG_RUNTIME_DIR = directory;

      const models = join(root, `models-${phase}.json`);
      writeFileSync(models, modelsJSON(answer));

      running = answer;
      child = spawn(binary, ["daemon", "run", "--models", models], {
        env: {
          ...process.env,
          CHAUFFEUR_DISTRIBUTION: distribution,
          XDG_CONFIG_HOME: config,
          XDG_STATE_HOME: state,
        },
        stdio: ["ignore", "ignore", "inherit"],
      });
      await waitForSocket();
    }

    /** Stops the daemon and waits for it to exit, so the next phase never races a dying one. */
    async function stopDaemon(): Promise<void> {
      const current = child;
      running = undefined;
      child = undefined;
      if (!current || current.exitCode !== null || current.signalCode !== null)
        return;

      await new Promise<void>((done) => {
        current.once("exit", () => done());
        current.kill();
      });
    }

    /** Polls until the daemon answers, then fails the test rather than leaving it to hang. */
    async function waitForSocket(): Promise<void> {
      const socket = chauffeurSocket("chauffeur-next");
      const deadline = Date.now() + READY_MS;

      while (Date.now() < deadline) {
        if (await probeChauffeur(socket)) return;
        await sleep(STEP_MS);
      }

      throw new Error(`no Chauffeur v2 answers on ${socket}`);
    }
  });
});
