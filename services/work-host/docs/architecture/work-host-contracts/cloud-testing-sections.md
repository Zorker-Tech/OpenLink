# Cloud testing sections

## Eligibility and placement

Cloud testing sections are available only when the configured model profile opts into the shell-less cloud prompt, the feature switch is on, the run source and agent type are known, and the environment supports cloud testing. Named-agent-home sessions and locally prompted runs do not receive the sections.

Placement metadata is validated before reuse. A prior `user_info` placement remains there. A prior `system_prompt` placement remains only for a Slate product prompt; otherwise it returns to user info. A first placement goes to the system prompt only when the Slate flag allows it.

## Section contents

The assembled sections include git/submission guidance, testing workflow and optional computer-use instructions. A computer-use subagent gets the compact desktop guidance, and the required shell tool name must be present. Missing model, source, tool or agent context omits the section group.

The external prompt-version marker is projected at the interop boundary; the prompt policy consumes Slate-owned booleans.

## Verification

Prompt placement and model-profile adapter tests pin eligibility, prior-placement recovery, feature-flag behavior, computer-use selection and external-version projection.
