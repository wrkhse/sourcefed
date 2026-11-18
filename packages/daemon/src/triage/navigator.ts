import type { ChauffeurEndpoint } from "./discover.ts"
import type { Navigator } from "./triage.ts"

/**
 * The part of @fdcn/chauffeur/client (1.0.0-rc.5, wrkhse/chauffeur#23) the daemon relies
 * on: `connect({ socket })` returns a connection of its own, and `Navigator` is that
 * connection's `navigate(request, { signal })` plus `close()`. It is declared here
 * because the client arrives as a release tarball, not a registry dependency.
 */
export type ChauffeurConnect = (options: { socket: string }) => Navigator

/**
 * `ChauffeurTriage`'s `connect` option. The wiring commit passes the client's own
 * `connect` and no triage code changes.
 */
export function chauffeurNavigators(connect: ChauffeurConnect): (endpoint: ChauffeurEndpoint) => Navigator {
  return (endpoint) => connect({ socket: endpoint.socket })
}
