import { failedJobLog } from "./failed-job-log.ts"
import { failedJobs } from "./failed-jobs.ts"
import { formatFailedCheck } from "./format-failed-check.ts"
import type { GithubClient } from "../../api"

const MAX_QUOTED_JOBS = 3

export async function ciFailureDetail(github: GithubClient, repo: string, failed: any[]): Promise<string> {
  const lines = failed.map(formatFailedCheck)
  for (const job of failedJobs(failed).slice(0, MAX_QUOTED_JOBS)) {
    const log = await failedJobLog(github, repo, job)
    if (log) lines.push(log)
  }
  return lines.join("\n")
}
