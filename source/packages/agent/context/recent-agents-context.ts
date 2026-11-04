export interface RecentAgentPromptInput {
  readonly name: string
  readonly path: string
  readonly overview?: string | undefined
}

export interface RecentAgentsTextContent {
  readonly type: "text"
  readonly text: string
}

export interface RenderRecentAgentsContextArgs {
  readonly recentAgents: readonly RecentAgentPromptInput[]
  readonly isComposerMatterhorn: boolean
  readonly isRawTrainingSlug: boolean
}

function entryText(agent: RecentAgentPromptInput): string {
  const summary = agent.overview?.trim()
  const summaryLine = summary ? `\n  overview: ${summary}` : ""
  return `- ${agent.name}${summaryLine}\n  transcript_path: ${agent.path}`
}

function shouldHideTranscriptLinks(args: RenderRecentAgentsContextArgs): boolean {
  return args.isComposerMatterhorn && args.isRawTrainingSlug
}

export function renderRecentAgentsContext({
  recentAgents,
  isComposerMatterhorn,
  isRawTrainingSlug,
}: RenderRecentAgentsContextArgs): RecentAgentsTextContent | undefined {
  if (shouldHideTranscriptLinks({ recentAgents, isComposerMatterhorn, isRawTrainingSlug })) return undefined
  if (recentAgents.length === 0) return undefined

  const entries = recentAgents.map(entryText).join("\n")
  return {
    type: "text",
    text: `<recent_agents_context>\nOther recent work is available in transcript files. Read a transcript only when it can inform the current question.\nSearch first, then read a few relevant sections instead of loading a whole transcript.\n${entries}\n</recent_agents_context>`,
  }
}
