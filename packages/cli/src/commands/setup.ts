import { installTriageRule, type RuleInstall } from "../utils/chauffeur-rule.ts"
import { flag } from "../utils/flags.ts"
import { setupHost, setupSpec } from "../utils/setup.ts"

export async function runSetup(args: string[]): Promise<void> {
  const spec = setupSpec()
  const requested = args[0] ?? "all"
  if (requested === "opencode" || requested === "all") {
    await setupHost("opencode", ["plugin", "add", spec], spec)
  }
  if (requested === "pi" || requested === "all") {
    await setupHost("pi", ["install", `npm:${spec}`], `npm:${spec}`)
  }
  if (requested === "chauffeur") {
    const result = await installTriageRule({ name: flag(args, "name") ?? "chauffeur-next" })
    printRuleInstall(result)
    if (result.status === "refused") process.exitCode = 1
  }
  if (requested === "all") {
    const result = await installTriageRule({ name: "chauffeur-next", requireConfigDir: true })
    if (result.status === "skipped") console.error(`[sourcefed] skipped the Chauffeur rule: ${result.reason}`)
    else printRuleInstall(result)
  }
}

function printRuleInstall(result: RuleInstall): void {
  if (result.status === "written") {
    console.error(`[sourcefed] wrote the sourcefed/triage rule to ${result.path}; Chauffeur v2 loads it on its next rule reload`)
    return
  }
  if (result.status === "present") {
    console.error(`[sourcefed] ${result.path} is already present; left as is`)
    return
  }
  if (result.status === "refused") console.error(`[sourcefed] ${result.reason}`)
}
