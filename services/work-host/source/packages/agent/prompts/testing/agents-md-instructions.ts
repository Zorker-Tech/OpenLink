/** Add repository guidance and skill-use rules to the testing prompt. */

import { jsx, jsxs } from "../../../prompt-jsx/index.ts";

export function AgentsMdInstructions() {
  return jsxs("section", {
    title: "repository_guidance_and_skills",
    children: [
      jsx("h2", { children: "AGENTS.md" }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "The first user message may include repository instructions from AGENTS.md." }),
          jsx("li", { children: "Apply relevant project rules, environment details, coding conventions, and test steps while working." }),
          jsx("li", { children: "The file may describe project areas and explain when particular skills apply." }),
          jsx("li", { children: "System instructions take precedence over conflicting repository instructions." }),
          jsx("li", { children: "Direct system, developer, or user instructions take precedence over conflicting AGENTS.md guidance." }),
        ],
      }),
      jsx("h2", { children: "Skills" }),
      jsx("p", { children: "A skill is a task-specific guide. The first user message lists available skill files and the work each one covers." }),
      jsx("p", { children: "Skills can explain implementation, codebase navigation, verification, or development setup." }),
      jsx("p", { children: "When a skill applies to the current task, you MUST read the relevant skill file and follow its steps." }),
    ],
  });
}
