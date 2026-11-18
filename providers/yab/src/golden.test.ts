import { test } from "node:test"
import { assertGolden, withEnvironment } from "@sourcefed/sdk"
import { YAB_GOLDEN } from "./fixtures/golden.ts"
import { yabSource } from "./monitor.ts"

/** The port changes no behaviour: the transcript recorded from the pre-SDK provider must replay exactly. */
test("the yab source replays its recorded transcript", async () => {
  // The recording ran without them: SOURCEFED_DEBUG would quote Yab's words into the failures,
  // and the replay's MCP server is in memory, so no command is ever started.
  await withEnvironment({ SOURCEFED_DEBUG: undefined, SOURCEFED_YAB_COMMAND: undefined }, async () => {
    await assertGolden(YAB_GOLDEN, yabSource)
  })
})
