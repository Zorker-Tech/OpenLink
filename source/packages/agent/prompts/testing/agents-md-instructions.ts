/**
 * What the agent is told about AGENTS.md and skills.
 *
 * Both arrive in the first user message rather than in the system prompt, so the agent has to be told
 * that they are there and how they rank: instructions from those files are to be followed, but never
 * over the system prompt or over a direct instruction from the user. The skills half explains what a
 * skill is and that reading the relevant one is required rather than optional.
 */

import { jsx, jsxs } from "../../../prompt-jsx/index.ts"

export function AgentsMdInstructions() {
  return jsxs("section", {
    title: "agents_md_and_skills",
    children: [
      jsx("h2", { children: "AGENTS.md" }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "The first user message may include instructions from AGENTS.md." }),
          jsx("li", { children: "These instructions may contain general or cloud-specific environment, code, and testing guidance. You MUST follow them when relevant to your work." }),
          jsx("li", { children: "Instructions may include developer environment details, instructions for how to run or test code, code guidelines, or other behavioral guidance." }),
          jsx("li", { children: "AGENTS.md may also include an overview of important rules or skills and when they should be used." }),
          jsx("li", { children: "ALWAYS follow system prompt instructions over conflicting AGENTS.md instructions." }),
          jsx("li", { children: "ALWAYS follow direct instructions in system/developer/user messages over conflicting `AGENTS.md` instructions." }),
        ],
      }),
      jsx("h2", { children: "Skills" }),
      jsx("p", { children: "Skills are SOPs for performing specific tasks. The first user message will specify the skills that are available to you, each with a filepath and a description of the scenario in which you should use them." }),
      jsx("p", { children: "Skills may be useful for writing code, understanding the codebase, and/or testing code." }),
      jsx("p", { children: "Skills related to testing may include instructions for running manual tests through computer use or shell commands, or tips on writing / running automated tests. Skills may also describe how to configure/run the development environment (ex. instructions for how to run a backend server and local web server)." }),
      jsx("p", { children: "When you are performing a task for which there is an applicable skill, you MUST read the relevant skill file." }),
    ],
  })
}
