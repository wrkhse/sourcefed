/** The most code points a subject's title keeps. */
export const MAX_SUBJECT_TITLE_CHARS = 300

/**
 * A subject's title, shared by sources so titles are cut the same way: trimmed,
 * cut to MAX_SUBJECT_TITLE_CHARS code points, and undefined when nothing is left.
 */
export function subjectTitle(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined

  const title = text.trim()
  if (!title) return undefined

  // Array.from yields whole code points, so the cut never splits a surrogate pair.
  const chars = Array.from(title)
  if (chars.length <= MAX_SUBJECT_TITLE_CHARS) return title
  return chars.slice(0, MAX_SUBJECT_TITLE_CHARS).join("")
}
