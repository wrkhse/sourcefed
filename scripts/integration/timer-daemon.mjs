// A packed daemon in its own process whose poll loop the test sets: the CLI's daemon has no
// setting for it. Started by provider-timer.test.mjs; stops gracefully on SIGTERM.
import {
  handleDaemonHttpRequest,
  serveHttp,
  SourcefedDaemon,
} from "@sourcefed/daemon";

const daemon = new SourcefedDaemon({
  stateDir: process.env.SOURCEFED_STATE_DIR,
  pollLoopSec: Number(process.env.TIMER_IT_POLL_LOOP_SEC),
});
await daemon.start();

const server = await serveHttp({
  hostname: "127.0.0.1",
  port: Number(process.env.SOURCEFED_DAEMON_PORT),
  handler: (request) => handleDaemonHttpRequest(daemon, request, {}),
});

process.once("SIGTERM", async () => {
  await server.stop();
  await daemon.stop();
  process.exit(0);
});
