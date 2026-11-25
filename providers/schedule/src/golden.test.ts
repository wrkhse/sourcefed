import { test } from "node:test";
import { assertGolden } from "@sourcefed/sdk";
import { SCHEDULE_GOLDEN } from "./fixtures/golden.ts";
import { scheduleSource } from "./monitor.ts";

/** The port changes no behaviour: the transcript recorded from the pre-SDK provider must replay exactly. */
test("the schedule source replays its recorded transcript", async () => {
  // Every case names its time zone and its instant, so nothing depends on the machine's clock or zone.
  await assertGolden(SCHEDULE_GOLDEN, scheduleSource);
});
