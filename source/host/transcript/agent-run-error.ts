/**
 * A run that failed, as the reader sees it.
 *
 * The platform's own failures — an overloaded provider, a refused request, a run that was cancelled — each have their
 * own title and detail, so a reader is told what happened rather than displayDetail a stack.
 */
export const PROVIDER_OVERLOAD_ERROR_TITLE = "Model provider is overloaded";
export const PROVIDER_OVERLOAD_ERROR_DETAIL =
  "The model provider is under heavy load right now. This is usually temporary — retry, or switch to another model.";
export const SLATE_INCLUDED_LIMIT_REASON = "slate_included_limit";
export const RESETS_AT_ABS_OR_ISO = /It resets at \S+\.?/g;
export const RESETS_IN_CLAUSE = /It resets in [^.]+/g;
export const MAX_TRAY_ACTIONS = 3;
export const SLATE_WEBSITE_ORIGIN = "https://slate.invalid";
export const SUPPORTED_DASHBOARD_ACTION_VERBS = new Set([
  "requestLimitIncrease",
]);
export interface BackendDetail {
  title?: string;
  detail?: string;
  buttons?: ErrorButton[];
  additionalInfo?: { rateLimitReason?: string; nextResetAt?: string };
}
export interface BackendConnectError extends Error {
  findDetails(type?: unknown): Array<{ details?: BackendDetail }>;
  code?: number;
}
function isBackendConnectError(value: unknown): value is BackendConnectError {
  return (
    value instanceof Error &&
    typeof (value as Partial<BackendConnectError>).findDetails === "function"
  );
}
export function walkForBackendConnectError(
  error: unknown,
  visited: Set<object>,
  fallback: { value: BackendConnectError | null },
): BackendConnectError | null {
  if (error == null || typeof error !== "object" || visited.has(error))
    return null;
  visited.add(error);
  if (isBackendConnectError(error)) {
    if (error.findDetails().length > 0) return error;
    fallback.value ??= error;
  }
  const cause = (error as { cause?: unknown }).cause,
    foundInCause = walkForBackendConnectError(cause, visited, fallback);
  if (foundInCause != null) return foundInCause;
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors))
    for (const nested of errors) {
      const foundError = walkForBackendConnectError(nested, visited, fallback);
      if (foundError != null) return foundError;
    }
  return null;
}
export function findBackendConnectError(
  error: unknown,
  needsDetails = true,
): BackendConnectError | null {
  const fallback = { value: null as BackendConnectError | null },
    withDetails = walkForBackendConnectError(error, new Set(), fallback);
  return withDetails ?? (needsDetails ? null : fallback.value);
}
export function getBackendErrorDetailMessage(error: unknown): string | null {
  const detail = findBackendConnectError(error)?.findDetails()[0]?.details,
    title = detail?.title?.trim(),
    message = detail?.detail?.trim();
  return !title
    ? (message ?? null)
    : !message || message === title
      ? title
      : `${title}\n\n${message}`;
}
export function formatAgentRunError(error: Error): string {
  return getBackendErrorDetailMessage(error) ?? error.message;
}
function pluralUnit(count: number): string {
  return count === 1 ? "" : "s";
}

export function formatSlateUsageResetIn(
  nextResetAt: string | Date,
  atMs = Date.now(),
): string | null {
  const resetTime =
    typeof nextResetAt === "string"
      ? Date.parse(nextResetAt)
      : nextResetAt.getTime();
  if (!Number.isFinite(resetTime)) return null;
  const ms = resetTime - atMs;
  if (ms <= 0) return "less than a minute";
  if (ms >= 86_400_000) {
    const days = Math.ceil(ms / 86_400_000);
    return `${days} day${pluralUnit(days)}`;
  }
  if (ms >= 3_600_000) {
    const hours = Math.ceil(ms / 3_600_000);
    return `${hours} hour${pluralUnit(hours)}`;
  }
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `${minutes} minute${pluralUnit(minutes)}`;
}
export function withRelativeSlateIncludedLimitReset(
  detail: string,
  nextResetAt: string | null | undefined,
  atMs = Date.now(),
): string {
  if (!nextResetAt) return detail;
  const relativeText = formatSlateUsageResetIn(nextResetAt, atMs);
  return relativeText == null
    ? detail
    : detail
        .replace(RESETS_AT_ABS_OR_ISO, `It resets in ${relativeText}.`)
        .replace(RESETS_IN_CLAUSE, `It resets in ${relativeText}`);
}
export type ErrorButton = {
  label: string;
  action: { case: string; value: any };
};
export function checkoutDeepControlUrl(action: {
  membershipToUpgradeTo?: string;
  allowTrial?: boolean;
}): string {
  const selectedTier = ["pro", "pro_plus", "ultra"].includes(
    action.membershipToUpgradeTo ?? "",
  )
    ? action.membershipToUpgradeTo
    : "pro";
  let url = `${SLATE_WEBSITE_ORIGIN}/api/auth/checkoutDeepControl?tier=${selectedTier}`;
  if (action.allowTrial === true) url += "&allowTrial=true";
  else if (action.allowTrial === false) url += "&allowTrial=false";
  return url;
}
function isWebProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

export function mapErrorDetailButtons(
  buttons: readonly ErrorButton[] | null | undefined,
): Array<Record<string, unknown>> {
  const actions: Array<Record<string, unknown>> = [];
  let switchSeen = false;
  for (const entry of buttons ?? []) {
    if (actions.length >= MAX_TRAY_ACTIONS) break;
    const value = entry.action.value ?? {};
    switch (entry.action.case) {
      case "url":
        try {
          const url = new URL(value.url);
          if (isWebProtocol(url.protocol) && entry.label)
            actions.push({
              kind: "open-url",
              label: entry.label,
              url: value.url,
            });
        } catch {}
        break;
      case "upgrade":
        actions.push({
          kind: "open-url",
          label: entry.label || "Upgrade",
          url: checkoutDeepControlUrl(value),
        });
        break;
      case "upgradeChoice":
        actions.push({
          kind: "open-url",
          label: entry.label || "Upgrade",
          url: `${SLATE_WEBSITE_ORIGIN}/pricing`,
        });
        break;
      case "switchModel":
        if (!switchSeen) {
          switchSeen = true;
          actions.push({ kind: "switch-model" });
        }
        break;
      case "dashboardAction":
        if (SUPPORTED_DASHBOARD_ACTION_VERBS.has(value.action) && entry.label)
          actions.push({
            kind: "dashboard-action",
            label: entry.label,
            action: value.action,
            args: { ...value.args },
            successMessage: value.successMessage || null,
          });
    }
  }
  return actions;
}
export function describeAgentRunError(error: unknown): Record<string, unknown> {
  const messageText =
      error instanceof Error ? formatAgentRunError(error) : String(error),
    detail = findBackendConnectError(error)?.findDetails()[0]?.details,
    title = detail?.title?.trim() ?? "",
    actions = mapErrorDetailButtons(detail?.buttons);
  let displayDetail = title ? (detail?.detail?.trim() ?? "") : messageText;
  if (detail?.additionalInfo?.rateLimitReason === SLATE_INCLUDED_LIMIT_REASON)
    displayDetail = withRelativeSlateIncludedLimitReset(
      displayDetail || messageText,
      detail.additionalInfo.nextResetAt,
    );
  else if (!displayDetail) displayDetail = messageText;
  return {
    ...(title ? { title } : {}),
    detail: displayDetail,
    ...(actions.length ? { actions } : {}),
  };
}
