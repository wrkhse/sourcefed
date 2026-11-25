import { connect } from "@fdcn/chauffeur/client";
import {
  ChauffeurTriage,
  chauffeurNavigators,
  SourcefedDaemon,
  type SourcefedDaemonOptions,
} from "@sourcefed/daemon";

/**
 * The daemon every command runs. Triage goes through Chauffeur v2's own client, so its verdicts
 * reach the sink; the options let a test compose this same daemon, with its own store and queue,
 * against a Chauffeur it started itself.
 */
export function createDaemon(
  options: SourcefedDaemonOptions = {},
): SourcefedDaemon {
  return new SourcefedDaemon({
    ...options,
    stateDir: options.stateDir ?? process.env.SOURCEFED_STATE_DIR,
    triage:
      options.triage ??
      new ChauffeurTriage({ connect: chauffeurNavigators(connect) }),
  });
}
