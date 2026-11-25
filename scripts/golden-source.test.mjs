import assert from "node:assert/strict";
import { test } from "node:test";
import { goldenSource } from "./golden-source.mjs";

test("goldenSource formats recorded values as a TypeScript fixture", () => {
  const header = "/** Example recording. */";
  const fixture = {
    cases: [
      {
        headers: { "content-type": "application/json" },
        labels: ["a", "b"],
        cursor: null,
        terminal: false,
      },
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
      headers: {
        "content-type": "application/json",
      },
      labels: ["a", "b"],
      cursor: null,
      terminal: false,
    },
  ],
  replies: [],
  headers: {},
};
`;

  assert.strictEqual(goldenSource(fixture, "EXAMPLE_GOLDEN", header), expected);
});

test("goldenSource wraps property values that exceed 80 columns", () => {
  const header = "/** Example recording. */";
  const labels = [
    "0123456789012345678901234567890",
    "01234567890123456789012345678901",
  ];
  const fixture = {
    fits: labels,
    wraps: labels,
    description:
      "A long description that fits only after moving it to its own line.",
  };

  const expected = `import type { GoldenFixture } from "@sourcefed/sdk";

/** Example recording. */
export const WRAPPED_GOLDEN: GoldenFixture = {
  fits: ["0123456789012345678901234567890", "01234567890123456789012345678901"],
  wraps: [
    "0123456789012345678901234567890",
    "01234567890123456789012345678901",
  ],
  description:
    "A long description that fits only after moving it to its own line.",
};
`;

  assert.strictEqual(goldenSource(fixture, "WRAPPED_GOLDEN", header), expected);
});
