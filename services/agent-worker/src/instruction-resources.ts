import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface InstructionResource {
  id: string
  name: string
  description: string
  text: string
}

const MAX_INSTRUCTION_BYTES = 12 * 1024
const INSTRUCTION_FILES: Array<{ path: string; name: string }> = [
  { path: 'AGENTS.md', name: 'AGENTS.md' },
  { path: 'CLAUDE.md', name: 'CLAUDE.md' },
  { path: '.cursorrules', name: '.cursorrules' },
  { path: '.openlink/instructions.md', name: '.openlink/instructions.md' },
]

/**
 * Project instruction files that the composer can explicitly attach to a
 * prompt. The Agent still loads its normal instruction chain; these resources
 * only make the files discoverable instead of requiring the user to remember
 * a path.
 */
export async function discoverInstructionResources(workspaceRoot: string): Promise<InstructionResource[]> {
  const resources: InstructionResource[] = []
  for (const file of INSTRUCTION_FILES) {
    const path = resolve(workspaceRoot, file.path)
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size <= 0 || info.size > MAX_INSTRUCTION_BYTES) continue
      const text = (await readFile(path, 'utf8')).trim()
      if (!text) continue
      resources.push({
        id: `instruction:${file.path}`,
        name: file.name,
        description: text.split('\n').find((line) => line.trim())?.slice(0, 180) ?? '',
        text,
      })
    } catch {
      // Missing or unreadable instruction files are normal.
    }
  }
  return resources
}
