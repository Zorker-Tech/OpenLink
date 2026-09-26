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

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { parseProjectPermissionsFileConfig } from "../config/project-permissions-file-provider.ts"

const MAX_PROJECT_PERMISSION_INSTRUCTIONS_PER_WORKSPACE = 20
const MAX_USER_AUTO_RUN_INSTRUCTIONS = 20
const MAX_PROJECT_PERMISSION_INSTRUCTION_CHARS = 1e3
const PROJECT_PERMISSIONS_FILE_NAME = ".slate/permissions.json"

interface AutoRunInstructions {
  readonly allowInstructions: readonly string[]
  readonly blockInstructions: readonly string[]
}

export interface SmartModeProjectPermissionsContext {
  readonly auto_run: {
    readonly allow_instructions: string[]
    readonly block_instructions: string[]
  }
  readonly truncated: boolean
}

function truncateInstruction(instruction: string): { value: string; truncated: boolean } {
  if (instruction.length <= MAX_PROJECT_PERMISSION_INSTRUCTION_CHARS) {
    return { value: instruction, truncated: false }
  }
  return {
    value: `${instruction.slice(0, MAX_PROJECT_PERMISSION_INSTRUCTION_CHARS)}
...[truncated]`,
    truncated: true,
  }
}

function truncateInstructions(
  instructions: readonly string[],
  maxCount: number,
): { values: string[]; truncated: boolean } {
  const sliced = instructions.slice(0, maxCount)
  // A list that was cut, or any instruction in it that was cut, is a truncated answer.
  let truncated = sliced.length < instructions.length || instructions.some(instruction => instruction.length > MAX_PROJECT_PERMISSION_INSTRUCTION_CHARS)
  const values = sliced.map(instruction => {
    const result = truncateInstruction(instruction)
    truncated ||= result.truncated
    return result.value
  })
  return { values, truncated }
}

function appendUniqueInstructions(target: string[], instructions: readonly string[]): void {
  const seen = new Set(target)
  for (const instruction of instructions) {
    if (seen.has(instruction)) continue
    seen.add(instruction)
    target.push(instruction)
  }
}

function appendUniqueInstructionsExcluding(
  target: string[],
  instructions: readonly string[],
  excludedInstructions: readonly string[],
): void {
  const seen = new Set([...excludedInstructions, ...target])
  for (const instruction of instructions) {
    if (seen.has(instruction)) continue
    seen.add(instruction)
    target.push(instruction)
  }
}

function hasAnyAutoRunInstructions(instructions: AutoRunInstructions | undefined): boolean {
  return instructions !== undefined && (instructions.allowInstructions.length > 0 || instructions.blockInstructions.length > 0)
}

export async function loadSmartModeProjectPermissionsContext(
  _ctx: unknown,
  workspacePaths: readonly string[] | undefined,
  userAutoRunInstructions: AutoRunInstructions | undefined,
  projectAutoRunInstructions: AutoRunInstructions | undefined,
): Promise<SmartModeProjectPermissionsContext | undefined> {
  const candidatePathSet = new Set<string>()
  if (workspacePaths !== undefined) {
    for (const workspacePath of workspacePaths) {
      if (typeof workspacePath !== "string") continue
      const trimmed = workspacePath.trim()
      if (trimmed.length === 0) continue
      candidatePathSet.add(join(trimmed, PROJECT_PERMISSIONS_FILE_NAME))
    }
  }
  const projectAllowInstructionsAggregate: string[] = []
  const projectBlockInstructionsAggregate: string[] = []
  let foundAnyPermissionsFile = hasAnyAutoRunInstructions(projectAutoRunInstructions)
  if (hasAnyAutoRunInstructions(projectAutoRunInstructions)) {
    // The caller already parsed the project's file, so its instructions are used as they are.
    appendUniqueInstructions(projectAllowInstructionsAggregate, projectAutoRunInstructions!.allowInstructions)
    appendUniqueInstructions(projectBlockInstructionsAggregate, projectAutoRunInstructions!.blockInstructions)
  } else {
    for (const filePath of candidatePathSet) {
      if (!existsSync(filePath)) continue
      try {
        const raw = await readFile(filePath, "utf8")
        const config = parseProjectPermissionsFileConfig(raw)
        if (config === undefined) continue
        foundAnyPermissionsFile = true
        if (config.autoRun?.allowInstructions !== undefined) {
          appendUniqueInstructions(projectAllowInstructionsAggregate, config.autoRun.allowInstructions)
        }
        if (config.autoRun?.blockInstructions !== undefined) {
          appendUniqueInstructions(projectBlockInstructionsAggregate, config.autoRun.blockInstructions)
        }
      } catch {
        // A workspace whose file cannot be read contributes nothing rather than failing the turn.
      }
    }
  }
  const userAllowInstructionsAggregate: string[] = []
  const userBlockInstructionsAggregate: string[] = []
  if (hasAnyAutoRunInstructions(userAutoRunInstructions)) {
    appendUniqueInstructionsExcluding(userAllowInstructionsAggregate, userAutoRunInstructions!.allowInstructions, projectAllowInstructionsAggregate)
    appendUniqueInstructionsExcluding(userBlockInstructionsAggregate, userAutoRunInstructions!.blockInstructions, projectBlockInstructionsAggregate)
  }
  // Nothing found anywhere means there is no policy to state, which is different from an empty one.
  if (!foundAnyPermissionsFile && !hasAnyAutoRunInstructions(userAutoRunInstructions)) return undefined
  const workspaceCount = Math.max(workspacePaths?.length ?? 1, 1)
  const maxProjectInstructions = MAX_PROJECT_PERMISSION_INSTRUCTIONS_PER_WORKSPACE * workspaceCount
  const projectAllowInstructions = truncateInstructions(projectAllowInstructionsAggregate, maxProjectInstructions)
  const projectBlockInstructions = truncateInstructions(projectBlockInstructionsAggregate, maxProjectInstructions)
  const userAllowInstructions = truncateInstructions(userAllowInstructionsAggregate, MAX_USER_AUTO_RUN_INSTRUCTIONS)
  const userBlockInstructions = truncateInstructions(userBlockInstructionsAggregate, MAX_USER_AUTO_RUN_INSTRUCTIONS)
  return {
    auto_run: {
      allow_instructions: [...projectAllowInstructions.values, ...userAllowInstructions.values],
      block_instructions: [...projectBlockInstructions.values, ...userBlockInstructions.values],
    },
    truncated: projectAllowInstructions.truncated || projectBlockInstructions.truncated || userAllowInstructions.truncated || userBlockInstructions.truncated,
  }
}
