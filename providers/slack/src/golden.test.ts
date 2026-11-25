import { test } from "node:test";
import { assertGolden, withEnvironment } from "@sourcefed/sdk";
import { SLACK_GOLDEN } from "./fixtures/golden.ts";
import { slackSource } from "./monitor.ts";
import { resetSlackApi } from "./poll";

/** The port changes no behaviour: the transcript recorded from the pre-SDK provider must replay exactly. */
test("the slack source replays its recorded transcript", async () => {
  await withEnvironment(
    {
      SOURCEFED_SLACK_TOKEN: "xoxb-test",
      SOURCEFED_SLACK_SIGNING_SECRET: "test-signing-secret",
      SOURCEFED_SLACK_REQUESTS_PER_MINUTE: undefined,
    },
    async () => {
      // The token's budget and the cached user list live in module-level state, so a test that
      // ran before this one could leave the token short of credit or its users already cached.
      // The recording ran in a fresh process; a reset starts from the same state, and builds the
      // limiter at the default rate now that the variable is unset.
      resetSlackApi();

      await assertGolden(SLACK_GOLDEN, slackSource);
    },
  );
});
