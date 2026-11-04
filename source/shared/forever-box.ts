/** A pending user interaction that can resume its waiting conversation. */
export interface BoxReturnTicket {
  readonly requestId: string;
}

export type BoxReturnCause = string;

export type BoxReturnPlan =
  | { readonly type: "untracked" }
  | {
      readonly type: "resume";
      readonly requestId: string;
      readonly cause: string;
      readonly outcome: "dismissed" | "handed_back";
    };

export function planBoxReturn(
  ticket: BoxReturnTicket | null | undefined,
  cause: BoxReturnCause,
): BoxReturnPlan {
  if (ticket == null) return { type: "untracked" };
  return {
    type: "resume",
    requestId: ticket.requestId,
    cause,
    outcome: cause === "dismissed" ? "dismissed" : "handed_back",
  };
}
