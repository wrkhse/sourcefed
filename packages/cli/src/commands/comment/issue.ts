import { flag } from "../../utils/flags.ts"
import { printResult } from "../../utils/format.ts"
import type { CommentContext } from "./index.ts"

export async function issue(context: CommentContext): Promise<void> {
  const repo = flag(context.args, "repo")
  const issueNumber = flag(context.args, "issue-number")
  const body = flag(context.args, "body")
  if (!repo) throw new Error("issue requires --repo owner/name")
  if (!issueNumber || !/^[1-9]\d*$/.test(issueNumber)) throw new Error("issue requires a positive integer --issue-number")
  if (body === undefined || !body.trim()) throw new Error("issue requires a non-empty --body")
  printResult(await context.client.request("comment.issue", { repo, issueNumber: Number(issueNumber), body }))
}
