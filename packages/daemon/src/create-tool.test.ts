import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { monitorCreateToolSchema, toDaemonCreateInput } from "./create-tool.ts";
import { SOURCE_TYPES } from "./registry.ts";

type Branch = {
  properties: Record<string, { enum?: string[] }>;
  required: string[];
  additionalProperties: boolean;
};

describe("monitor_create tool schema", () => {
  test("offers one branch per source, tagged by type and closed to other fields", () => {
    const schema = monitorCreateToolSchema() as {
      properties: { source: { anyOf: Branch[] } };
    };

    const branches = schema.properties.source.anyOf;

    assert.deepEqual(
      branches.map((branch) => branch.properties.type.enum),
      SOURCE_TYPES.map((type) => [type]),
    );
    for (const branch of branches) {
      assert.equal(branch.required[0], "type");
      assert.equal(branch.additionalProperties, false);
    }
  });

  test("the github-issues branch offers issueNumbers and requires only repo", () => {
    const schema = monitorCreateToolSchema() as {
      properties: { source: { anyOf: Branch[] } };
    };
    const branch = schema.properties.source.anyOf.find(
      (item) => item.properties.type.enum?.[0] === "github-issues",
    );
    if (!branch) assert.fail("github-issues branch");

    assert.deepEqual(branch.properties.issueNumbers, {
      type: "array",
      items: { type: "integer", minimum: 1 },
      maxItems: 100,
      description: "Watch only these issue numbers, e.g. [56]",
    });
    assert.deepEqual(branch.required, ["type", "repo"]);
  });

  test("flattens a tool input into the daemon's create input", () => {
    const input = {
      name: "PR #42",
      source: { type: "github", repo: "octo/repo", prNumber: 42 },
      pollIntervalSec: 30,
    };

    assert.deepEqual(toDaemonCreateInput(input), {
      name: "PR #42",
      sourceType: "github",
      repo: "octo/repo",
      prNumber: 42,
      pollIntervalSec: 30,
    });
  });

  test("keeps issue numbers intact when flattening a github-issues source", () => {
    const input = {
      name: "Issues",
      source: { type: "github-issues", repo: "octo/repo", issueNumbers: [56] },
    };

    assert.deepEqual(toDaemonCreateInput(input), {
      name: "Issues",
      sourceType: "github-issues",
      repo: "octo/repo",
      issueNumbers: [56],
    });
  });

  test("refuses an input without a tagged source", () => {
    assert.throws(
      () =>
        toDaemonCreateInput({
          name: "x",
          sourceType: "jira",
          issueKey: "PROJ-1",
        }),
      /requires source/,
    );
  });
});
