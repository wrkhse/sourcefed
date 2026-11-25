import assert from "node:assert/strict";
import { test } from "node:test";
import { goldenSource } from "./golden-source.mjs";

test("goldenSource formats recorded values as a TypeScript fixture", () => {
  const header = "/** Example recording. */";
  const fixture = {
    cases: [
      { "content-type": "application/json", cursor: null, terminal: false },
    ],
    replies: [],
    headers: {},
    now: undefined,
  };

  const expected = `import type { GoldenFixture } from "@sourcefed/sdk";

/** Example recording. */
export const EXAMPLE_GOLDEN: GoldenFixture = {
  cases: [
    {
      "content-type": "application/json",
      cursor: null,
      terminal: false,
    },
  ],
  replies: [],
  headers: {},
};
`;

  assert.equal(goldenSource(fixture, "EXAMPLE_GOLDEN", header), expected);
});
