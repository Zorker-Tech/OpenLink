/**
 * When a box that was handed to the user comes back.
 *
 * A box is handed over for the user to work in, and it comes back either because they dismissed the hand-over or
 * because they gave it back deliberately; anything else is no decision at all, and a hand-over that is no longer the
 * current one is not resumed.
 */
export interface BoxHandoff {
  readonly requestId: string;
}

export type BoxHandBackTrigger = "dismissed" | string;

export type BoxHandBackDecision =
  | { readonly kind: "none" }
  | {
      readonly kind: "resume";
      readonly requestId: string;
      readonly trigger: string;
      readonly resolution: "dismissed" | "handed_back";
    };

export function decideBoxHandBack(
  handoff: BoxHandoff | null | undefined,
  trigger: BoxHandBackTrigger,
): BoxHandBackDecision {
  if (handoff == null) return { kind: "none" };
  return {
    kind: "resume",
    requestId: handoff.requestId,
    trigger,
    resolution: trigger === "dismissed" ? "dismissed" : "handed_back",
  };
}
