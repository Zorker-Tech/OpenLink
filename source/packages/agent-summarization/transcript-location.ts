/**
 * Where the conversation's own transcript is, said to the model in a way it can act on.
 *
 * A conversation that has been summarized has lost the detail behind the summary, and the transcript is
 * where that detail still is. So the model is told where the file is and how to use it: search for the
 * thing it is unsure about rather than reading the file, because the file is large and a single line of it
 * can be enormous. When the conversation id is known the exact file is named; when it is not, the folder is
 * named and the naming scheme with it, which is what a model needs to find its own file.
 *
 * The same text is offered in two shapes, because one prompt version reads a markdown section and another
 * reads a tag it was trained on. The tag form is the same text with the heading taken off and the
 * indentation removed, since the tag is what marks the block there.
 */

import { join } from "node:path"

import { getTranscriptRelativePath } from "../../host/transcript/agent-transcript/paths.ts"
import { TRANSCRIPTS_SUBDIR } from "../utils/conversation-paths.ts"

export function formatTranscriptLocation(
  agentTranscriptsFolder: string,
  options?: { readonly conversationId?: string | undefined; readonly useXml?: boolean | undefined } | null,
): string {
  const conversationId = options?.conversationId
  const useXml = options?.useXml === true
  const markdownSection = formatTranscriptLocationMarkdownSection(agentTranscriptsFolder, conversationId)
  if (!useXml) return markdownSection
  // The tag carries the block, so the heading and the indentation that the markdown form needed are removed.
  const xmlContent = markdownSection
    .replace("\n\n### Transcript location:\n", "")
    .replace(/^ {2}/gm, "")
    .trimEnd()
  return `\n\n<transcript_location>\n${xmlContent}\n</transcript_location>`
}

function formatTranscriptLocationMarkdownSection(agentTranscriptsFolder: string, conversationId?: string): string {
  if (conversationId) {
    const transcriptRelativePath = getTranscriptRelativePath({
      conversationId,
      ext: "jsonl",
      kind: "primary",
    })
    // The folder is joined with the path inside it, since the model is given a path it can open.
    const transcriptPath = join(agentTranscriptsFolder, stripTranscriptsDirPrefix(transcriptRelativePath))
    return `\n\n### Transcript location:
  This is the full JSONL transcript of your past conversation with the user (pre- and post-summary): ${transcriptPath}

  If anything about the task or current state is unclear (missing context, ambiguous requirements, uncertain decisions, exact wording, IDs/paths, errors/logs), you should consult this transcript.

  How to use it:
  - Search first for relevant keywords (task name, filenames, IDs, errors, tool names).
  - Then read a small window around the matching lines to reconstruct intent and state.
  - Avoid reading linearly end-to-end; the file can be very large and some single lines can be huge.
  - Files contain one structured json event per line including user/assistant messages. Currently tool calls and results are excluded.
  `
  }
  return `\n\n### Transcript location:
  - This folder contains full transcripts of past conversations with the user (pre- and post-summary): ${agentTranscriptsFolder}
  - Each conversation is stored as a <convoId>/<convoId>.jsonl.`
}

function stripTranscriptsDirPrefix(relativePath: string): string {
  const prefix = `${TRANSCRIPTS_SUBDIR}/`
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : relativePath
}
