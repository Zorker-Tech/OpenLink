/**
 * What happens to a turn while a review of it is waiting.
 *
 * An agent under review is stopped at the gate until the review is answered, and a review that was refused ends the
 * turn rather than letting it continue as if nothing happened.
 */
import {
  AutoReviewApprovalWaitError,
  type AutoReviewGatePorts,
  type AutoReviewModes,
} from "./auto-review-gate-contracts.ts";
import {
  surfacesWithoutEnforcement,
  visibleReviewInstructions,
} from "./auto-review-gate-policy.ts";

export { AutoReviewApprovalWaitError } from "./auto-review-gate-contracts.ts";
export type { AutoReviewModes } from "./auto-review-gate-contracts.ts";

export function createAutoReviewGate(deps: AutoReviewGatePorts) {
  const generations = { host_shell: 0, box_shell: 0 };
  return {
    currentModes(): AutoReviewModes {
      const modes = deps.getModes?.() ?? deps.baseModes;
      deps.controller()?.expireSurfaces(surfacesWithoutEnforcement(modes));
      return modes;
    },
    assertNoPendingApproval(): void {
      const pending = deps.controller()?.getPendingApprovals() ?? [];
      if (pending.length > 0) {
        throw new AutoReviewApprovalWaitError(
          "This turn has a review decision waiting; finish it before starting another action.",
        );
      }
    },
    userInstructions() {
      return visibleReviewInstructions(deps.getInstructions?.());
    },
    shellApprovalState(surface: "host_shell" | "box_shell") {
      return {
        getIdentity: () =>
          `${surface}:${surface === "box_shell" ? `${deps.resolveBoxId()}:` : ""}${generations[surface]}`,
        markSideEffectStart: () => {
          generations[surface] += 1;
        },
      };
    },
  };
}
