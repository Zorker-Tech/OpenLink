/** Applies workspace ignore inputs to sandbox rules before they reach the shell core. */
import {
  type SandboxRule,
} from "./sandbox-policy.ts";
import {
  forcedShellSandboxPolicy,
  isForcedShellEgressEnabled,
  type ForcedEgressParsingResult,
} from "./forced-egress.ts";
import type { WorkspaceIgnoreSource } from "./shell-stream-contracts.ts";

async function withWorkspaceIgnoreMap(rule: SandboxRule, ignore: WorkspaceIgnoreSource): Promise<SandboxRule> {
  if (rule.type === "insecure_none") return rule;
  return { ...rule, type: rule.type, ignoreMapping: await ignore.getWorkspaceIgnoreMapping() };
}

export async function requestedShellPolicy(
  requested: SandboxRule | undefined,
  ignore: WorkspaceIgnoreSource,
): Promise<SandboxRule | undefined> {
  if (requested === undefined) return undefined;
  return withWorkspaceIgnoreMap(requested, ignore);
}

export async function forcedShellPolicy(
  command: string,
  parsing: ForcedEgressParsingResult,
  ignore: WorkspaceIgnoreSource,
): Promise<SandboxRule | undefined> {
  if (!isForcedShellEgressEnabled()) return undefined;
  return withWorkspaceIgnoreMap(forcedShellSandboxPolicy(command, parsing), ignore);
}
