import type { AutoReviewInstructions, AutoReviewModes } from "./auto-review-gate-contracts.ts";

const MODE_SURFACES: ReadonlyArray<{
  readonly mode: keyof AutoReviewModes;
  readonly surface: string;
}> = [
  { mode: "hostShell", surface: "host_shell" },
  { mode: "boxShell", surface: "box_shell" },
  { mode: "mcp", surface: "mcp" },
  { mode: "computer", surface: "computer" },
  { mode: "automationWrite", surface: "automation_write" },
  { mode: "cloudAgent", surface: "cloud_agent" },
  { mode: "subagentLaunch", surface: "subagent" },
];

export function surfacesWithoutEnforcement(modes: AutoReviewModes): Set<string> {
  return new Set(
    MODE_SURFACES
      .filter(({ mode }) => modes[mode] !== "enforce")
      .map(({ surface }) => surface),
  );
}

export function visibleReviewInstructions(
  instructions: AutoReviewInstructions | undefined,
): AutoReviewInstructions | undefined {
  if (instructions == null
    || (instructions.allowInstructions.length === 0 && instructions.blockInstructions.length === 0)) {
    return undefined;
  }
  return {
    allowInstructions: [...instructions.allowInstructions],
    blockInstructions: [...instructions.blockInstructions],
  };
}
