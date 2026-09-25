/**
 * Where the agent is told its past conversations live.
 *
 * Transcripts are files in the workspace, so the agent can read what it or another agent did before —
 * which is often the only record of a decision. Whether it may point the user at one depends on where
 * the user is: in an editor the transcript is a chat the user can open, and elsewhere naming the file
 * would be naming something they cannot.
 */

import { jsx, jsxs } from "../../prompt-jsx/index.ts"
import type { PromptNode } from "../../prompt-jsx/index.ts"
import { AgentType } from "../utils/agent-config.ts"

export function AgentTranscriptsSection({ agentTranscriptsFolder, agentType, enableAgentChatLinks }: {
  readonly agentTranscriptsFolder: string
  readonly agentType?: AgentType | undefined
  readonly enableAgentChatLinks?: boolean | undefined
}): PromptNode {
  const isIDE = agentType === AgentType.IDE
  const citationInstruction = isIDE
    ? [
      `cite parent chat transcripts to the user as [<title for chat <=6 words>](<uuid excluding .jsonl>).${enableAgentChatLinks ? "" : " Do not cite subagent transcript files from this folder."}`,
      "Don't discuss the folder structure.",
    ].join(" ")
    : "Don't cite the file directly to the user."
  return jsx("section", {
    title: "agent_transcripts",
    children: jsxs("p", {
      children: [
        "Agent transcripts (past chats) live in ",
        agentTranscriptsFolder,
        ". They have names like ",
        "<uuid>",
        ".jsonl, ",
        citationInstruction,
      ],
    }),
  })
}
