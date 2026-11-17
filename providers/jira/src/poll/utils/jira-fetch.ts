import { PollSourceError } from "@sourcefed/core"
import { jiraAuth } from "./jira-auth.ts"

const JIRA_BASE = process.env.SOURCEFED_JIRA_BASE_URL

export async function jiraFetch(path: string): Promise<any> {
  if (!JIRA_BASE) throw new PollSourceError("SOURCEFED_JIRA_BASE_URL is required for Jira monitors")

  const headers = { Authorization: jiraAuth(), Accept: "application/json" }
  let response: Response
  try {
    response = await fetch(`${JIRA_BASE}/rest/api/3${path}`, { headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new PollSourceError(`Jira ${path} request failed: ${message}`, { cause: error })
  }
  if (!response.ok) throw new PollSourceError(`Jira ${response.status} for ${path}`)
  try {
    return await response.json()
  } catch (error) {
    throw new PollSourceError(`Jira ${path} gave a body that is not JSON`, { cause: error })
  }
}
