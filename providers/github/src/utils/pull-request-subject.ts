import { subjectTitle, type EventSubject } from "@sourcefed/core"

/** What an event is about, for programs: the pull request's repo, number and title. */
export function pullRequestSubject(repo: string, number: number, title: unknown): EventSubject {
  const subject: EventSubject = { type: "github-pull-request", key: `${repo}#${number}`, repo, number }
  const text = subjectTitle(title)
  // A pull request with no title still has a subject; only the title is left out.
  if (text !== undefined) subject.title = text
  return subject
}
