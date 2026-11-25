import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isPollSourceError, PollSourceError } from "./poll-source-error.ts";

const BRAND = Symbol.for("sourcefed.pollSourceError");

describe("PollSourceError", () => {
  test("the guard accepts a poll failure", () => {
    assert.equal(
      isPollSourceError(new PollSourceError("upstream unavailable")),
      true,
    );
  });

  test("the guard rejects a plain Error and a look-alike", () => {
    assert.equal(isPollSourceError(new Error("upstream unavailable")), false);
    assert.equal(
      isPollSourceError({
        name: "PollSourceError",
        message: "upstream unavailable",
      }),
      false,
    );
    assert.equal(isPollSourceError({ [BRAND]: true }), false);
    assert.equal(isPollSourceError("upstream unavailable"), false);
  });

  test("the brand is hidden, so a spread or a copy does not carry it", () => {
    const failure = new PollSourceError("upstream unavailable");
    assert.equal(
      Object.getOwnPropertyDescriptor(failure, BRAND)?.enumerable,
      false,
      "the brand is non-enumerable",
    );
    assert.equal(isPollSourceError({ ...failure }), false);
  });
});
