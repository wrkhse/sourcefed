import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sourcefedExtension from "./index.ts";

// Records what the extension registers. Pi names a command by everything up to the first
// space, so a registered name containing one can never be typed.
function recordingPi(): { commands: string[]; pi: ExtensionAPI } {
  const commands: string[] = [];
  const pi = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (name: string) => {
      commands.push(name);
    },
  };
  return { commands, pi: pi as unknown as ExtensionAPI };
}

test("registers the notifications dialog under the name Pi can run", async () => {
  const { commands, pi } = recordingPi();

  await sourcefedExtension(pi);

  assert.deepEqual(commands, ["sourcefed", "sourcefed-logs"]);
  for (const name of commands) {
    assert.equal(/\s/.test(name), false, `"${name}" contains whitespace`);
  }
});
