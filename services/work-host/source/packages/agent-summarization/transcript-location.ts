/** Describe where a model can find the conversation history that a summary omitted. */
import { join } from "node:path"
import { transcriptFilePath } from "../../host/transcript/agent-transcript/paths.ts"
import { TRANSCRIPTS_SUBDIR } from "../utils/conversation-paths.ts"

interface TranscriptLocationOptions {
  readonly conversationId?: string | undefined
  readonly useXml?: boolean | undefined
}

const TRANSCRIPT_HEADING = "\n\n### Transcript location:\n"

export function formatTranscriptLocation(
  agentTranscriptsFolder: string,
  options?: TranscriptLocationOptions | null,
): string {
  const markdown = options?.conversationId
    ? formatConversationFileLocation(agentTranscriptsFolder, options.conversationId)
    : formatTranscriptFolderLocation(agentTranscriptsFolder)
  return options?.useXml === true ? wrapLocationAsXml(markdown) : markdown
}

function formatConversationFileLocation(folder: string, conversationId: string): string {
  const relativePath = transcriptFilePath({
    conversationId,
    ext: "jsonl",
    kind: "primary",
  })
  const filePath = join(folder, removeTranscriptDirectory(relativePath))
  return `${TRANSCRIPT_HEADING}  This JSONL file contains the full conversation history, including messages before and after summaries: ${filePath}

  Search it when an earlier decision, exact wording, identifier, path, or error needs context.

  Suggested approach:
  - Search for a distinctive filename, identifier, tool, phrase, or error first.
  - Read a short span around useful matches to recover the surrounding discussion.
  - Avoid scanning the full file; it can be large, and some entries can be long.
  - Each line is one conversation event. Tool requests and results are not recorded here.
  `
}

function formatTranscriptFolderLocation(folder: string): string {
  return `${TRANSCRIPT_HEADING}  This directory holds full conversation histories, including the parts before and after summaries: ${folder}
  - Open a conversation's JSONL file at <conversation-id>/<conversation-id>.jsonl.
  `
}

function removeTranscriptDirectory(relativePath: string): string {
  const prefix = `${TRANSCRIPTS_SUBDIR}/`
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : relativePath
}

function wrapLocationAsXml(markdown: string): string {
  const content = markdown
    .replace(TRANSCRIPT_HEADING, "")
    .replace(/^ {2}/gm, "")
    .trimEnd()
  return `\n\n<transcript_location>\n${content}\n</transcript_location>`
}
