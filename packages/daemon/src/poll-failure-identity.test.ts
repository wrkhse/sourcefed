import assert from "node:assert/strict";
import { test } from "node:test";
import type { MonitorContext } from "@sourcefed/core";
import { isPollSourceError, PollSourceError } from "@sourcefed/core";

// Every bundle carries its own PollSourceError (scripts/build.mjs bundles each provider with
// only node:* external), so the daemon has to recognise a failure thrown by a provider's
// copy. This drives the built bundles the daemon loads at runtime, not the sources.
test("a provider's built bundle throws a poll failure the daemon recognises", async () => {
  delete process.env.SOURCEFED_JIRA_BASE_URL;
  const built = (await import(
    new URL("../../core/dist/index.js", import.meta.url).href
  )) as { isPollSourceError: typeof isPollSourceError };
  const jira = (await import(
    new URL("../../../providers/jira/dist/index.js", import.meta.url).href
  )) as {
    JiraMonitor: {
      poll?: {
        run: (
          context: MonitorContext,
          source: unknown,
          record: unknown,
        ) => Promise<number>;
      };
    };
  };

  const monitor = jira.JiraMonitor;
  const record = {
    id: "m-bundle-test",
    name: "test",
    source: { type: "jira", issueKey: "PROJ-1" },
    delivery: "poll",
    target: { kind: "test", id: "session-1" },
    pollIntervalSec: 60,
    enabled: true,
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
    cursors: {},
  };
  const context = {
    service: { get: async () => record },
    sink: { deliver: async () => ({ ok: true }) },
    sources: {},
    sourceForWebhookPath: () => undefined,
  } as unknown as MonitorContext;

  const failure = await monitor.poll!.run(context, monitor, record).then(
    () => undefined,
    (error: unknown) => error,
  );

  assert.ok(failure instanceof Error, "the provider threw");
  assert.ok(
    !(failure instanceof PollSourceError),
    "the provider's bundle has its own copy of the class",
  );
  assert.ok(isPollSourceError(failure), "the brand is what the daemon checks");
  assert.ok(built.isPollSourceError(failure), "the built bundle agrees");
  assert.match(failure.message, /SOURCEFED_JIRA_BASE_URL/);
});
