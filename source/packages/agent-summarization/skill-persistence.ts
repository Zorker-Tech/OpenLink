const ATTACHED_SKILL_BLOCK = /<manually_attached_skills>[\s\S]*?<\/manually_attached_skills>/g

/** Extract the complete blocks Slate carries forward when an older conversation is compacted. */
export function extractAttachedSkillBlocks(textSegments: readonly string[]): string[] {
  const blocks: string[] = []
  for (const segment of textSegments) {
    const matches = segment.match(ATTACHED_SKILL_BLOCK) ?? []
    for (const match of matches) {
      const block = match.trim()
      if (block.length > 0) blocks.push(block)
    }
  }
  return blocks
}
