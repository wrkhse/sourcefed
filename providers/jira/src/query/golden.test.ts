import { test } from "node:test"
import { assertGolden, withEnvironment } from "@sourcefed/sdk"
import { JIRA_QUERY_GOLDEN } from "./fixtures/golden.ts"
import { jiraQuerySource } from "./monitor.ts"

/** The port changes no behaviour: the transcript recorded from the pre-SDK provider must replay exactly. */
test("the jira-query source replays its recorded transcript", async () => {
  await withEnvironment(
    {
      SOURCEFED_JIRA_BASE_URL: JIRA_QUERY_GOLDEN.base,
      ATLASSIAN_EMAIL: "test@example.com",
      ATLASSIAN_API_KEY: "test-key",
    },
    async () => {
      await assertGolden(JIRA_QUERY_GOLDEN, jiraQuerySource)
    },
  )
})
