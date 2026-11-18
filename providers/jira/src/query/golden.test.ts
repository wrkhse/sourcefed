import { test } from "node:test"
import { assertGolden } from "@sourcefed/sdk"
import { JIRA_QUERY_GOLDEN } from "./fixtures/golden.ts"
import { jiraQuerySource } from "./monitor.ts"

process.env.SOURCEFED_JIRA_BASE_URL = JIRA_QUERY_GOLDEN.base
process.env.ATLASSIAN_EMAIL = "test@example.com"
process.env.ATLASSIAN_API_KEY = "test-key"

/** The port changes no behaviour: the transcript recorded from the pre-SDK provider must replay exactly. */
test("the jira-query source replays its recorded transcript", async () => {
  await assertGolden(JIRA_QUERY_GOLDEN, jiraQuerySource)
})
