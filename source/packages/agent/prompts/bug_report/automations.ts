/**
 * The tools an automation run is given for its own memory.
 *
 * An automation fires repeatedly, and what it learned last time is the only thing that makes this run
 * better than the first. Its memories are ordinary files in a mounted store, so the instructions say
 * where they are and how to use them rather than introducing a memory tool: the agent reads them at the
 * start, updates them with ordinary edits, and prefers per-topic files once topics diverge.
 *
 * The instructions are written before the stores are known — the prompt is assembled from the request
 * context, the mounts come from the run — so the block is placed as a marker and materialized here,
 * where the mounted store is in hand. A run with no automation store is told the memory is unavailable
 * and to continue without it, which is better than being told to read a directory that is not there.
 */

import path from "node:path"

import { AGENT_STORE_AUTOMATION_MOUNT_NAME } from "../../../constants/agent-store-ids.ts"

export interface AutomationMemoryMount {
  readonly alias?: string | undefined
  readonly path?: string | undefined
}

/** The tool-name spelling an automation's own tools are registered under. */
export function automationToolNameToSnakeCase(name: string): string {
  const characters = [...name]
  let normalized = ""
  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index]!
    const previous = characters[index - 1]
    const following = characters[index + 1]
    const startsWord = /[A-Z]/.test(current) && previous !== undefined && (
      /[a-z0-9]/.test(previous) ||
      (/[A-Z]/.test(previous) && following !== undefined && /[a-z]/.test(following))
    )
    normalized += `${startsWord ? "_" : ""}${current.toLowerCase()}`
  }
  return normalized
}

const AUTOMATION_MEMORY_DIRECTORY_NAME = "memories"
const AUTOMATION_MEMORY_DEFAULT_FILE = "MEMORIES.md"
export const AUTOMATION_MEMORY_INSTRUCTION_MARKER = "__SLATE_AUTOMATION_MEMORY_INSTRUCTIONS__"

/** A mount path comes from whichever machine holds the store, so it is joined the way that machine would. */
function getMountedPathModule(mountPath: string): typeof path.posix | typeof path.win32 {
  return path.win32.isAbsolute(mountPath) && !path.posix.isAbsolute(mountPath) ? path.win32 : path.posix
}

function resolveAutomationMemoryDirectory(stores: readonly AutomationMemoryMount[]): string | undefined {
  const configuredPath = stores.find(store => store.alias === AGENT_STORE_AUTOMATION_MOUNT_NAME)?.path?.trim()
  if (configuredPath === undefined || configuredPath.length === 0) return undefined
  const mountPath = configuredPath
  return getMountedPathModule(mountPath).join(mountPath, AUTOMATION_MEMORY_DIRECTORY_NAME)
}

function buildAutomationMemoryInstruction(memoryDirectory: string): string {
  const pathModule = getMountedPathModule(memoryDirectory)
  const defaultFile = pathModule.join(memoryDirectory, AUTOMATION_MEMORY_DEFAULT_FILE)
  const directoryPrefix = `${memoryDirectory}${pathModule.sep}`
  return [
    `Keep this automation's durable notes under ${memoryDirectory} and use the regular file tools to work with them.`,
    `At each run's start, check ${directoryPrefix} and read ${defaultFile} when present, followed by any topic note that applies.`,
    "When you discover something a future run should retain, edit the notes directly.",
    "Keep notes brief and factual. Read the latest contents before replacing a file, since another run may have updated it.",
    `As subjects diverge, keep separate topic files under ${directoryPrefix} instead of growing one note indefinitely.`,
    "There is no separate memory tool; manage these notes with ordinary file operations.",
  ].join(" ")
}

export function materializeAutomationMemoryInstruction(
  automationInstructions: string,
  stores: readonly AutomationMemoryMount[],
): string {
  if (!automationInstructions.includes(AUTOMATION_MEMORY_INSTRUCTION_MARKER)) return automationInstructions
  const memoryDirectory = resolveAutomationMemoryDirectory(stores)
  const replacement = memoryDirectory !== undefined
    ? buildAutomationMemoryInstruction(memoryDirectory)
    : "No automation memory store is mounted for this run. Do not read or write memory files; continue with the context and tools available."
  return automationInstructions.split(AUTOMATION_MEMORY_INSTRUCTION_MARKER).join(replacement)
}
