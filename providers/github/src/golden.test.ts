import { test } from "node:test"
import { assertGolden, withEnvironment } from "@sourcefed/sdk"
import { resetGithubApi } from "./api/client.ts"
import { GITHUB_GOLDEN } from "./fixtures/golden.ts"
import { githubSource } from "./monitor.ts"

/** The port changes no behaviour: the transcript recorded from the pre-SDK provider must replay exactly. */
test("the github pull request source replays its recorded transcript", async () => {
  await withEnvironment(
    {
      GH_TOKEN: "test-token",
      SOURCEFED_GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
      GITHUB_TOKEN: undefined,
      SOURCEFED_GITHUB_REQUESTS_PER_MINUTE: undefined,
    },
    async () => {
      // The token's budget and waits live in one process-wide limiter, so a test that ran
      // before this one could leave the token short of credit or waiting; a fresh limiter
      // starts from the recording's state.
      resetGithubApi()

      await assertGolden(GITHUB_GOLDEN, githubSource)
    },
  )
})
