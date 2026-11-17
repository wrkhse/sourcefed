import type { EventSubject } from "@sourcefed/core"

// Chauffeur's thread evidence reads a pull request as "#42: <title>"; longer titles are cut
// so that line stays readable.
const MAX_TITLE_LENGTH = 300

/** What an event is about, for programs: the pull request's repo, number and title. */
export function pullRequestSubject(repo: string, number: number, title: unknown): EventSubject {
  const subject: EventSubject = { type: "github-pull-request", key: `${repo}#${number}`, repo, number }
  const text = typeof title === "string" ? title.trim().slice(0, MAX_TITLE_LENGTH) : ""
  // A pull request with no title still has a subject; only the title is left out.
  if (text) subject.title = text
  return subject
}
