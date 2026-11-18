import { test } from "node:test"
import { assertGolden, withEnvironment } from "@sourcefed/sdk"
import { JIRA_GOLDEN } from "./fixtures/golden.ts"
import { jiraSource } from "./monitor.ts"

/** The port changes no behaviour: the transcript recorded from the pre-SDK provider must replay exactly. */
test("the jira source replays its recorded transcript", async () => {
  await withEnvironment(
    {
      SOURCEFED_JIRA_BASE_URL: JIRA_GOLDEN.base,
      ATLASSIAN_EMAIL: "test@example.com",
      ATLASSIAN_API_KEY: "test-key",
      SOURCEFED_JIRA_TERMINAL_STATUS: undefined,
    },
    async () => {
      await assertGolden(JIRA_GOLDEN, jiraSource)
    },
  )
})
