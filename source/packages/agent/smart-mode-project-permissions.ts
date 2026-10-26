/**
 * What the platform may run unattended, gathered from the user and from the project.
 *
 * Two sources say the same thing at different scopes. The user's own configuration applies wherever they
 * work; a project's file says what that project allows. Both are read here and merged into one policy for
 * the turn, because a single instruction may be given twice — by the user and by the project — and a
 * duplicate that appears twice in a prompt reads like two instructions.
 *
 * The project's file is looked for in each workspace the turn touches, and its instructions are aggregated
 * first, so the user's own instructions can be deduplicated against them: what the project already says is
 * not repeated by the user's. When the project's instructions were already parsed by the caller, that parse
 * is used instead of reading the files again, since the same file read twice is the same file.
 *
 * Both are bounded. An instruction is shortened past its limit and marked, and a project's instructions are
 * bounded per workspace, since a project that says a great deal should not fill the prompt on its own. The
 * result says whether anything was shortened, which is what tells the model that what it is reading is not
 * the whole of what was written.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseProjectPermissionsFileConfig } from "../config/project-permissions-file-provider.ts";

const PROJECT_RULES_PER_WORKSPACE = 20;
const USER_RULES_LIMIT = 20;
const RULE_TEXT_LIMIT = 1_000;
const PROJECT_RULES_FILENAME = ".slate/permissions.json";

interface InstructionPolicy {
  readonly allowInstructions: readonly string[];
  readonly blockInstructions: readonly string[];
}

interface RuleAccumulator {
  readonly allow: string[];
  readonly block: string[];
  present: boolean;
}

export interface SmartModeProjectPermissionsContext {
  readonly auto_run: {
    readonly allow_instructions: string[];
    readonly block_instructions: string[];
  };
  readonly truncated: boolean;
}

function boundedRuleText(instruction: string): { readonly value: string; readonly cut: boolean } {
  if (instruction.length <= RULE_TEXT_LIMIT) return { value: instruction, cut: false };
  return {
    value: `${instruction.slice(0, RULE_TEXT_LIMIT)}\n...[truncated]`,
    cut: true,
  };
}

function capRuleList(instructions: readonly string[], limit: number): { readonly values: string[]; readonly cut: boolean } {
  const kept = instructions.slice(0, limit);
  let cut = kept.length < instructions.length
    || instructions.some((instruction) => instruction.length > RULE_TEXT_LIMIT);
  const values = kept.map((instruction) => {
    const bounded = boundedRuleText(instruction);
    cut ||= bounded.cut;
    return bounded.value;
  });
  return { values, cut };
}

function appendUnseen(target: string[], incoming: readonly string[], excluded: readonly string[] = []): void {
  const alreadyAdded = new Set([...excluded, ...target]);
  for (const instruction of incoming) {
    if (alreadyAdded.has(instruction)) continue;
    alreadyAdded.add(instruction);
    target.push(instruction);
  }
}

function policyHasRules(policy: InstructionPolicy | undefined): boolean {
  return policy !== undefined && (policy.allowInstructions.length > 0 || policy.blockInstructions.length > 0);
}

function workspacePermissionFiles(workspaces: readonly string[] | undefined): string[] {
  const paths = new Set<string>();
  if (workspaces === undefined) return [];

  for (const candidate of workspaces) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    paths.add(join(trimmed, PROJECT_RULES_FILENAME));
  }
  return [...paths];
}

function addProvidedProjectRules(target: RuleAccumulator, supplied: InstructionPolicy): void {
  appendUnseen(target.allow, supplied.allowInstructions);
  appendUnseen(target.block, supplied.blockInstructions);
}

function addParsedProjectRules(target: RuleAccumulator, raw: string): void {
  const parsed = parseProjectPermissionsFileConfig(raw);
  if (parsed === undefined) return;
  target.present = true;
  if (parsed.autoRun?.allowInstructions !== undefined) appendUnseen(target.allow, parsed.autoRun.allowInstructions);
  if (parsed.autoRun?.blockInstructions !== undefined) appendUnseen(target.block, parsed.autoRun.blockInstructions);
}

async function collectProjectRules(
  files: readonly string[],
  alreadyParsed: InstructionPolicy | undefined,
): Promise<RuleAccumulator> {
  const project: RuleAccumulator = {
    allow: [],
    block: [],
    present: policyHasRules(alreadyParsed),
  };

  if (alreadyParsed !== undefined && policyHasRules(alreadyParsed)) {
    addProvidedProjectRules(project, alreadyParsed);
    return project;
  }

  for (const filePath of files) {
    if (!existsSync(filePath)) continue;
    try {
      addParsedProjectRules(project, await readFile(filePath, "utf8"));
    } catch {
      // A workspace whose file cannot be read contributes nothing rather than failing the turn.
    }
  }
  return project;
}

function collectUserRules(user: InstructionPolicy | undefined, project: RuleAccumulator): RuleAccumulator {
  const personal: RuleAccumulator = { allow: [], block: [], present: policyHasRules(user) };
  if (user !== undefined && policyHasRules(user)) {
    appendUnseen(personal.allow, user.allowInstructions, project.allow);
    appendUnseen(personal.block, user.blockInstructions, project.block);
  }
  return personal;
}

function combineBoundedRules(
  project: RuleAccumulator,
  personal: RuleAccumulator,
  workspaces: readonly string[] | undefined,
): SmartModeProjectPermissionsContext {
  const workspaceCount = Math.max(workspaces?.length ?? 1, 1);
  const projectLimit = PROJECT_RULES_PER_WORKSPACE * workspaceCount;
  const projectAllow = capRuleList(project.allow, projectLimit);
  const projectBlock = capRuleList(project.block, projectLimit);
  const personalAllow = capRuleList(personal.allow, USER_RULES_LIMIT);
  const personalBlock = capRuleList(personal.block, USER_RULES_LIMIT);

  return {
    auto_run: {
      allow_instructions: [...projectAllow.values, ...personalAllow.values],
      block_instructions: [...projectBlock.values, ...personalBlock.values],
    },
    truncated: projectAllow.cut || projectBlock.cut || personalAllow.cut || personalBlock.cut,
  };
}

export async function loadSmartModeProjectPermissionsContext(
  _ctx: unknown,
  workspacePaths: readonly string[] | undefined,
  userAutoRunInstructions: InstructionPolicy | undefined,
  projectAutoRunInstructions: InstructionPolicy | undefined,
): Promise<SmartModeProjectPermissionsContext | undefined> {
  const project = await collectProjectRules(
    workspacePermissionFiles(workspacePaths),
    projectAutoRunInstructions,
  );
  const personal = collectUserRules(userAutoRunInstructions, project);

  if (!project.present && !personal.present) return undefined;
  return combineBoundedRules(project, personal, workspacePaths);
}
