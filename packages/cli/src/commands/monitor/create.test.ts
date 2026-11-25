import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { create } from "./create.ts";
import type { MonitorContext } from "./index.ts";

async function createInput(
  args: string[],
): Promise<Record<string, unknown> | undefined> {
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  const client = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      requests.push({ method, params });
      if (method === "daemon.sourceTypes")
        return { sourceTypes: ["github-issues"] };
      return { ok: true };
    },
  } as unknown as MonitorContext["client"];
  const context: MonitorContext = {
    client,
    target: { kind: "cli", id: "host" },
    args,
  };

  const log = console.log;
  console.log = () => {};
  try {
    await create(context);
  } finally {
    console.log = log;
  }

  return requests.find((request) => request.method === "monitor.create")
    ?.params;
}

describe("monitor create flags", () => {
  test("parses comma-separated issue numbers", async () => {
    assert.deepEqual(
      await createInput([
        "--source-type",
        "github-issues",
        "--repo",
        "octo/repo",
        "--issue-numbers",
        "56, 57",
      ]),
      {
        name: "github-issues",
        sourceType: "github-issues",
        target: { kind: "cli", id: "host" },
        repo: "octo/repo",
        issueNumbers: [56, 57],
      },
    );
  });

  test("refuses a comma-separated list that is not all integers", async () => {
    await assert.rejects(
      createInput([
        "--source-type",
        "github-issues",
        "--issue-numbers",
        "56,nope",
      ]),
      /issue-numbers/,
    );
  });

  test("refuses more than 100 issue numbers before dispatch", async () => {
    const issueNumbers = Array.from({ length: 101 }, (_, i) => i + 1).join(",");

    await assert.rejects(
      createInput([
        "--source-type",
        "github-issues",
        "--issue-numbers",
        issueNumbers,
      ]),
      /issueNumbers/,
    );
  });

  test("refuses duplicate issue numbers before dispatch", async () => {
    await assert.rejects(
      createInput([
        "--source-type",
        "github-issues",
        "--issue-numbers",
        "56,56",
      ]),
      /issueNumbers/,
    );
  });
});
