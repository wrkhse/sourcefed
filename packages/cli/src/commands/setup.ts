import {
  CHAUFFEUR_NAMES,
  installTriageRule,
  type RuleInstall,
} from "../utils/chauffeur-rule.ts";
import { setupHost, setupSpec } from "../utils/setup.ts";

export type SetupTarget = "all" | "opencode" | "pi" | "chauffeur";

export type SetupArgs =
  | { target: SetupTarget; name: string; update: boolean }
  | { error: string };

function isSetupTarget(value: string | undefined): value is SetupTarget {
  return (
    value === "all" ||
    value === "opencode" ||
    value === "pi" ||
    value === "chauffeur"
  );
}

/** Reads `sourcefed setup` arguments, so a target or name it cannot act on is reported rather than ignored. */
export function parseSetupArgs(args: string[]): SetupArgs {
  const target = args[0] ?? "all";

  if (!isSetupTarget(target)) {
    return {
      error: `unknown setup target ${target}; expected opencode, pi or chauffeur (sourcefed setup chauffeur --name chauffeur)`,
    };
  }

  const index = args.findIndex(
    (arg) => arg === "--name" || arg.startsWith("--name="),
  );
  const update = args.includes("--update");
  let name = "chauffeur-next";

  if (index !== -1) {
    if (target !== "chauffeur") {
      return {
        error: `--name is only valid with the chauffeur target, not ${target}`,
      };
    }

    const value =
      args[index] === "--name"
        ? args[index + 1]
        : args[index].slice("--name=".length);

    if (
      value === undefined ||
      !(CHAUFFEUR_NAMES as readonly string[]).includes(value)
    ) {
      return {
        error: `--name needs a value of ${CHAUFFEUR_NAMES.join(" or ")}`,
      };
    }

    name = value;
  }

  if (update && target !== "chauffeur") {
    return {
      error: `--update is only valid with the chauffeur target, not ${target}`,
    };
  }

  return { target, name, update };
}

export async function runSetup(args: string[]): Promise<void> {
  const parsed = parseSetupArgs(args);

  if ("error" in parsed) {
    console.error(`[sourcefed] ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const spec = setupSpec();

  if (parsed.target === "opencode" || parsed.target === "all") {
    await setupHost("opencode", ["plugin", "add", spec], spec);
  }
  if (parsed.target === "pi" || parsed.target === "all") {
    await setupHost("pi", ["install", `npm:${spec}`], `npm:${spec}`);
  }
  if (parsed.target === "chauffeur") {
    const result = await installTriageRule({
      name: parsed.name,
      update: parsed.update,
    });
    printRuleInstall(result);
    if (result.status === "refused") process.exitCode = 1;
  }
  if (parsed.target === "all") {
    const result = await installTriageRule({
      name: parsed.name,
      requireConfigDir: true,
    });
    if (result.status === "skipped")
      console.error(`[sourcefed] skipped the Chauffeur rule: ${result.reason}`);
    else printRuleInstall(result);
  }
}

function printRuleInstall(result: RuleInstall): void {
  if (result.status === "written") {
    console.error(
      `[sourcefed] wrote the sourcefed/triage rule to ${result.path}; Chauffeur v2 loads it on its next rule reload`,
    );
    return;
  }
  if (result.status === "present") {
    console.error(`[sourcefed] ${result.path} is already present; left as is`);
    return;
  }
  if (result.status === "updated") {
    console.error(
      `[sourcefed] updated the sourcefed/triage rule at ${result.path}; Chauffeur v2 loads it on its next rule reload`,
    );
    return;
  }
  if (result.status === "refused")
    console.error(`[sourcefed] ${result.reason}`);
}
