import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { subjectTitle } from "./subject-title.ts"

// A high surrogate with no low after it, or a low surrogate with no high before it.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe("subjectTitle", () => {
  test("is undefined when the text is not a string", () => {
    assert.equal(subjectTitle(undefined), undefined)
    assert.equal(subjectTitle(null), undefined)
    assert.equal(subjectTitle(42), undefined)
  })

  test("is undefined when the text is only whitespace", () => {
    assert.equal(subjectTitle(" \n\t "), undefined)
  })

  test("trims the text", () => {
    assert.equal(subjectTitle("  Add schedules "), "Add schedules")
  })

  test("cuts 400 ASCII characters to 300", () => {
    const title = subjectTitle("x".repeat(400))

    assert.equal(title, "x".repeat(300))
    assert.equal(title?.length, 300)
  })

  test("never splits an emoji at the cut", () => {
    const title = subjectTitle("a".repeat(299) + "😀😀")

    assert.equal(title, "a".repeat(299) + "😀")
    assert.equal(title?.length, 301)
    assert.equal(loneSurrogate.test(title ?? ""), false)
  })
})
