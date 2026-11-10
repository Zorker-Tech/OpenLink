/** Describe where prior agent conversations are stored and when they may be linked. */

import { jsx, jsxs } from "../../prompt-jsx/index.ts";
import type { PromptNode } from "../../prompt-jsx/index.ts";
import { AgentType } from "../utils/agent-config.ts";

function citationGuidance(agentType: AgentType | undefined, enableAgentChatLinks: boolean): string[] {
  if (agentType !== AgentType.IDE) return ["Outside the editor, do not cite the path directly to the user."];

  return [
    "In the editor, link a parent conversation with a title of at most six words and its UUID without the .jsonl suffix.",
    ...(enableAgentChatLinks ? [] : ["Do not point the user to subagent transcript files in this folder."]),
    "Do not explain the directory layout.",
  ];
}

export function AgentTranscriptsSection({
  agentTranscriptsFolder,
  agentType,
  enableAgentChatLinks,
}: {
  readonly agentTranscriptsFolder: string;
  readonly agentType?: AgentType | undefined;
  readonly enableAgentChatLinks?: boolean | undefined;
}): PromptNode {
  const guidance = citationGuidance(agentType, enableAgentChatLinks === true);
  return jsx("section", {
    title: "agent_transcripts",
    children: jsxs("p", {
      children: [
        "Earlier agent conversations are kept under ",
        agentTranscriptsFolder,
        " in .jsonl files. ",
        guidance.join(" "),
      ],
    }),
  });
}
