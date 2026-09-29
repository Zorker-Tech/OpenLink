/**
 * What happens to a turn while a review of it is waiting.
 *
 * An agent under review is stopped at the gate until the review is answered, and a review that was refused ends the
 * turn rather than letting it continue as if nothing happened.
 */
import type { SlateAutoReviewController, SlateAutoReviewMode } from "./slate-auto-review.ts";

export class SlateAutoReviewPendingApprovalError extends Error {
  override readonly name = "SlateAutoReviewPendingApprovalError";
}

export interface AutoReviewModes {
  readonly hostShell: SlateAutoReviewMode;
  readonly boxShell: SlateAutoReviewMode;
  readonly mcp: SlateAutoReviewMode;
  readonly computer: SlateAutoReviewMode;
  readonly automationWrite: SlateAutoReviewMode;
  readonly cloudAgent: SlateAutoReviewMode;
  readonly subagentLaunch: SlateAutoReviewMode;
}

export interface AutoReviewGateDependencies {
  readonly baseModes: AutoReviewModes;
  readonly getModes?: () => AutoReviewModes;
  readonly controller: () => SlateAutoReviewController | undefined;
  readonly resolveBoxId: () => string;
  readonly getInstructions?: () => {
    readonly allowInstructions: readonly string[];
    readonly blockInstructions: readonly string[];
  } | undefined;
}

export function createAutoReviewGate(deps: AutoReviewGateDependencies) {
  const shellApprovalStateGeneration = { host_shell: 0, box_shell: 0 };
  return {
    currentModes(): AutoReviewModes {
      const modes = deps.getModes?.() ?? deps.baseModes;
      const nonEnforcingSurfaces = new Set<string>();
      if (modes.hostShell !== "enforce") nonEnforcingSurfaces.add("host_shell");
      if (modes.boxShell !== "enforce") nonEnforcingSurfaces.add("box_shell");
      if (modes.mcp !== "enforce") nonEnforcingSurfaces.add("mcp");
      if (modes.computer !== "enforce") nonEnforcingSurfaces.add("computer");
      if (modes.automationWrite !== "enforce") {
        nonEnforcingSurfaces.add("automation_write");
      }
      if (modes.cloudAgent !== "enforce") nonEnforcingSurfaces.add("cloud_agent");
      if (modes.subagentLaunch !== "enforce") nonEnforcingSurfaces.add("subagent");
      deps.controller()?.expireSurfaces(nonEnforcingSurfaces);
      return modes;
    },
    assertNoPendingApproval(): void {
      const pending = deps.controller()?.getPendingApprovals() ?? [];
      if (pending.length > 0) {
        throw new SlateAutoReviewPendingApprovalError(
          "Another action is waiting for Auto-review approval; no new side effect may start yet.",
        );
      }
    },
    userInstructions() {
      const instructions = deps.getInstructions?.();
      if (
        instructions == null
        || (
          instructions.allowInstructions.length === 0
          && instructions.blockInstructions.length === 0
        )
      ) return undefined;
      return {
        allowInstructions: [...instructions.allowInstructions],
        blockInstructions: [...instructions.blockInstructions],
      };
    },
    shellApprovalState(surface: "host_shell" | "box_shell") {
      return {
        getIdentity: () =>
          `${surface}:${surface === "box_shell" ? `${deps.resolveBoxId()}:` : ""}${shellApprovalStateGeneration[surface]}`,
        markSideEffectStart: () => {
          shellApprovalStateGeneration[surface] += 1;
        },
      };
    },
  };
}
