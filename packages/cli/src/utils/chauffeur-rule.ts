import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chauffeurSocket, probeChauffeur } from "@sourcefed/daemon";

/**
 * The canonical text of Chauffeur v2's sourcefed/triage rule.
 *
 * Its instructions port v1's event-gate question (chauffeur main
 * 95d976bd630e541155a4ccce66d0cdf8e7481249: skills/config/event-gate.json texts.question, and
 * its withhold_bodies "[message without text]" from capabilities/event-gate/src/lib.rs) to v2's
 * named evidence blocks: System One at confidence 0.7, and only a "no" withholds. Chauffeur's
 * real-model replay uses this text.
 */
export const TRIAGE_RULE = {
  on: "sourcefed.event",
  judges: {
    quick: {
      tier: "system-one",
      confidence: 0.7,
    },
  },
  strategy: [
    {
      id: "screen",
      judge: "quick",
      ask: {
        outcomes: ["yes", "no"],
        evidence: ["event", "thread", "monitor"],
        instructions:
          'A sourcefed event arrived for the coding agent\'s session. The event block gives its source, kind, summary and body, and whether sourcefed marks it actionable or informational; the thread block names the item it is about, when known; the monitor block says what this session\'s monitor follows. Should the agent be shown this event now? Answer yes for events that need the agent to do something: CI failures, requested changes, questions or requests addressed to it or its user, merge conflicts, a merged pull request with follow-up work, and new facts that change the work it is doing. Answer no for noise: bot comments, approvals, status or assignee changes nobody asked it to act on, thanks, and anything it has already handled. A chat message is noise unless it asks something, gives a task, or adds a fact the work needs: acknowledgements, side remarks and logistics between colleagues ("ok", "on it", "moving this to DM", "which doc?") are noise, and so is a message without text (body "[message without text]").',
      },
    },
  ],
  then: [
    {
      if: {
        screen: "no",
      },
      withhold: "event",
    },
  ],
};

/**
 * The names setup accepts. The default is "chauffeur-next": v1 reads ~/.config/chauffeur/rules,
 * so the rule goes to chauffeur-next until Chauffeur's cutover; slice 13 flips the default.
 */
export const CHAUFFEUR_NAMES = ["chauffeur-next", "chauffeur"] as const;

export type RuleInstall = {
  status: "written" | "present" | "refused" | "skipped";
  path: string;
  reason?: string;
};

/** The config folder this environment reads, matching Chauffeur's own XDG rule. */
function configHome(env: Readonly<Record<string, string | undefined>>): string {
  return env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

/** Where one Chauffeur install keeps the sourcefed rules. */
export function triageRulePath(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return path.join(configHome(env), name, "rules", "sourcefed", "triage.json");
}

/**
 * Installs the sourcefed/triage rule for one Chauffeur v2 install, never overwriting a rule that
 * is already there. Chauffeur v1 reads the same rules folder under its own name, so "chauffeur"
 * is only written when a v2 daemon answers on that name's socket.
 */
export async function installTriageRule(options: {
  name: string;
  env?: Record<string, string | undefined>;
  requireConfigDir?: boolean;
  probe?: (socket: string) => Promise<unknown>;
}): Promise<RuleInstall> {
  const {
    name,
    env = process.env,
    requireConfigDir = false,
    probe = probeChauffeur,
  } = options;

  if (!(CHAUFFEUR_NAMES as readonly string[]).includes(name)) {
    throw new Error(
      `unknown Chauffeur name "${name}"; allowed names: ${CHAUFFEUR_NAMES.join(", ")}`,
    );
  }

  const file = triageRulePath(name, env);
  const configDirectory = path.join(configHome(env), name);

  if (requireConfigDir && !existsSync(configDirectory)) {
    return {
      status: "skipped",
      path: file,
      reason: `${configDirectory} does not exist; Chauffeur is not set up there`,
    };
  }

  if (name !== "chauffeur-next") {
    const socket = chauffeurSocket(name, env);
    const endpoint = await probe(socket);

    if (!endpoint) {
      return {
        status: "refused",
        path: file,
        reason: `no Chauffeur v2 answers on ${socket}; ${path.join(configDirectory, "rules")} is read by Chauffeur v1, so the v2 rule is not written there. Use --name chauffeur-next until cutover.`,
      };
    }
  }

  if (existsSync(file)) return { status: "present", path: file };

  await mkdir(path.dirname(file), { recursive: true });

  try {
    await writeFile(file, `${JSON.stringify(TRIAGE_RULE, null, 2)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
  } catch (error) {
    // Another installer won the race; its file stands.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "EEXIST"
    ) {
      return { status: "present", path: file };
    }

    throw error;
  }

  return { status: "written", path: file };
}
