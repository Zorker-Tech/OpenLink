export function resolveTurnTraceSampleRatio(raw = process.env.SLATE_TURN_TRACE_SAMPLE_RATIO): number {
  if (!raw) return 1;
  const ratio = Number.parseFloat(raw);
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 1;
}

export function resolveTurnTraceType(options: {
  automationWake?: unknown;
  requestSource?: string;
  hidden?: boolean;
}): string {
  if (options.automationWake != null) return "automation";
  if (options.requestSource != null && options.requestSource !== "turn") return options.requestSource;
  return options.hidden === true ? "hidden" : "user";
}

export function resolveTurnTraceOutcome(result: {
  quiescedForUpgrade?: boolean;
  aborted?: boolean;
  awaitingUserSelection?: boolean;
}): string {
  if (result.quiescedForUpgrade === true) return "quiesced_for_upgrade";
  if (result.aborted) return "aborted";
  if (result.awaitingUserSelection === true) return "awaiting_user";
  return "success";
}
