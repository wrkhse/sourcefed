import { test } from "node:test"
import { assertGolden } from "@sourcefed/sdk"
import { JIRA_GOLDEN } from "./fixtures/golden.ts"
import { jiraSource } from "./monitor.ts"

process.env.SOURCEFED_JIRA_BASE_URL = JIRA_GOLDEN.base
process.env.ATLASSIAN_EMAIL = "test@example.com"
process.env.ATLASSIAN_API_KEY = "test-key"
delete process.env.SOURCEFED_JIRA_TERMINAL_STATUS

/** The port changes no behaviour: the transcript recorded from the pre-SDK provider must replay exactly. */
test("the jira source replays its recorded transcript", async () => {
  await assertGolden(JIRA_GOLDEN, jiraSource)
})
