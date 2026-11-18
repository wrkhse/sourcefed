import { test } from "node:test"
import { assertGolden, withEnvironment } from "@sourcefed/sdk"
import { resetGithubApi } from "../api/client.ts"
import { GITHUB_ISSUES_GOLDEN } from "./fixtures/golden.ts"
import { githubIssuesSource } from "./monitor.ts"

/** The port changes no behaviour: the transcript recorded from the pre-SDK provider must replay exactly. */
test("the github-issues source replays its recorded transcript", async () => {
  await withEnvironment(
    {
      GH_TOKEN: "test-token",
      GITHUB_TOKEN: undefined,
      SOURCEFED_GITHUB_REQUESTS_PER_MINUTE: "75",
    },
    async () => {
      // At the default rate the token's burst is four polls and the recording's clock is frozen,
      // so a fifth case would be refused for budget instead of reaching its 429. At 75 a minute
      // the burst is eight, and no case depends on how much time passes. The limiter reads the
      // rate when it is built, so it is set before the reset builds a fresh one.
      resetGithubApi()

      await assertGolden(GITHUB_ISSUES_GOLDEN, githubIssuesSource)
    },
  )
})
