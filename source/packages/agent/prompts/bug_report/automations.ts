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
import { MountedAgentStoreKind, type MountedAgentStore } from "../../../proto/generated/agent/v1/request_context_exec_pb.ts"

/** The tool-name spelling an automation's own tools are registered under. */
export function automationToolNameToSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase()
}

const AUTOMATION_MEMORY_DIRECTORY_NAME = "memories"
const AUTOMATION_MEMORY_DEFAULT_FILE = "MEMORIES.md"
export const AUTOMATION_MEMORY_INSTRUCTION_MARKER = "__SLATE_AUTOMATION_MEMORY_INSTRUCTIONS__"
const AUTOMATION_MEMORY_UNAVAILABLE_INSTRUCTION =
  "Automation memory is unavailable for this run. Do not attempt to read or write memory; continue with the available context and tools."

/** A mount path comes from whichever machine holds the store, so it is joined the way that machine would. */
function getMountedPathModule(mountPath: string): typeof path.posix | typeof path.win32 {
  return path.win32.isAbsolute(mountPath) && !path.posix.isAbsolute(mountPath) ? path.win32 : path.posix
}

function resolveAutomationMemoryDirectory(stores: readonly MountedAgentStore[]): string | undefined {
  const automationStore = stores.find(store =>
    store.kind === MountedAgentStoreKind.PRINCIPAL && store.alias === AGENT_STORE_AUTOMATION_MOUNT_NAME)
  const mountPath = automationStore?.path?.trim()
  if (mountPath === undefined || mountPath.length === 0) return undefined
  return getMountedPathModule(mountPath).join(mountPath, AUTOMATION_MEMORY_DIRECTORY_NAME)
}

function buildAutomationMemoryInstruction(memoryDirectory: string): string {
  const pathModule = getMountedPathModule(memoryDirectory)
  const defaultFile = pathModule.join(memoryDirectory, AUTOMATION_MEMORY_DEFAULT_FILE)
  const directoryPrefix = `${memoryDirectory}${pathModule.sep}`
  return [
    `Your durable memories live in the directory ${memoryDirectory}; use your normal file tools on it.`,
    `At the start of a run, inspect ${directoryPrefix} for prior context. Read ${defaultFile} if it exists, along with any relevant topic files.`,
    "When you learn something that should persist across runs, update those files with ordinary file edits.",
    "Prefer short, factual notes. Re-read a file before rewriting it if another run may have changed it.",
    `Prefer per-topic files under ${directoryPrefix} over one ever-growing note when topics diverge.`,
    "Do not invent a memory tool — write the files directly.",
  ].join(" ")
}

export function materializeAutomationMemoryInstruction(
  automationInstructions: string,
  stores: readonly MountedAgentStore[],
): string {
  if (!automationInstructions.includes(AUTOMATION_MEMORY_INSTRUCTION_MARKER)) return automationInstructions
  const memoryDirectory = resolveAutomationMemoryDirectory(stores)
  const replacement = memoryDirectory !== undefined
    ? buildAutomationMemoryInstruction(memoryDirectory)
    : AUTOMATION_MEMORY_UNAVAILABLE_INSTRUCTION
  return automationInstructions.split(AUTOMATION_MEMORY_INSTRUCTION_MARKER).join(replacement)
}
