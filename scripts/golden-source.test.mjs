import assert from "node:assert/strict";
import { test } from "node:test";
import { goldenSource } from "./golden-source.mjs";

test("goldenSource embeds indented JSON in a TypeScript fixture", () => {
  const header = "/** Example recording. */";
  const fixture = {
    cases: [
      {
        headers: { "content-type": "application/json" },
        labels: ["a", "b"],
        description:
          "This deliberately long description stays on one line even when its property exceeds eighty columns.",
        message: "She said \"try 'a'\" and he said \"try 'b'\".",
        cursor: null,
        terminal: false,
      },
    ],
    replies: [],
    headers: {},
    now: undefined,
  };

  const expected = String.raw`import type { GoldenFixture } from "@sourcefed/sdk";

/** Example recording. */
export const EXAMPLE_GOLDEN: GoldenFixture = {
  "cases": [
    {
      "headers": {
        "content-type": "application/json"
      },
      "labels": [
        "a",
        "b"
      ],
      "description": "This deliberately long description stays on one line even when its property exceeds eighty columns.",
      "message": "She said \"try 'a'\" and he said \"try 'b'\".",
      "cursor": null,
      "terminal": false
    }
  ],
  "replies": [],
  "headers": {}
};
`;

  assert.strictEqual(goldenSource(fixture, "EXAMPLE_GOLDEN", header), expected);
});
