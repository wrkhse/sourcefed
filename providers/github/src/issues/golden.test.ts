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
      SOURCEFED_GITHUB_REQUESTS_PER_MINUTE: undefined,
    },
    async () => {
      // Each case runs at its own instant, so the token's budget refills between polls as it
      // does for real monitors, and no case depends on how much real time passes. The limiter
      // reads the rate when it is built, so the reset after the variables builds it at the default.
      resetGithubApi()

      await assertGolden(GITHUB_ISSUES_GOLDEN, githubIssuesSource)
    },
  )
})
