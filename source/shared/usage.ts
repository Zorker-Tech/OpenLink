/**
 * What an account has used, and what is left.
 *
 * Usage arrives from the account's own service and is read into the shape a surface shows: the plan, the limits, what
 * has been spent in the window, and the moment it resets — with a value that is missing or unreadable treated as
 * unknown rather than as zero, since an unknown usage is not an unused one.
 */
/**
 * Cross-process usage and billing value contracts.
 *
 * The 0.18 electron-main artifact retains one runtime value from this module:
 * the dashboard-action allowlist below. The rest of the original module's
 * structural contracts were erased by TypeScript and are recovered from the
 * account projection and renderer intake checks that consume them.
 */

export type SupportedDashboardAction = "requestLimitIncrease";

/** Exact runtime state retained at `dist/electron-main/main.cjs:387117-387122`. */
export const SUPPORTED_DASHBOARD_ACTIONS = new Set<SupportedDashboardAction>([
  "requestLimitIncrease",
]);

export interface DashboardActionRequest {
  readonly action: SupportedDashboardAction;
  readonly args: Readonly<Record<string, string>>;
}

export interface UsageActionResult {
  readonly ok: boolean;
  readonly message: string | null;
}

export interface SlateWeeklyOnDemandUsage {
  readonly usedCents: number;
  readonly limitCents: number;
}

/** Shape projected by `toWeeklyUsage` and admitted by the renderer intake. */
export interface SlateWeeklyUsage {
  readonly percentUsed: number;
  readonly nextResetMs: number | null;
  readonly hasNonZeroIncludedLimit: boolean;
  readonly onDemand: SlateWeeklyOnDemandUsage | null;
}

export interface SlateUsageOnDemand {
  readonly usedCents: number;
  readonly limitCents: number | null;
  readonly resetTimestampMs: number | null;
}

export interface SlateUsageOpenUrlAction {
  readonly kind: "open-url";
  readonly url: string;
}

export interface SlateUsageDashboardAction {
  readonly kind: "dashboard-action";
  readonly action: SupportedDashboardAction;
  readonly args: Readonly<Record<string, string>>;
  readonly successMessage: string | null;
}

export type SlateUsageUpgradeAction =
  | SlateUsageOpenUrlAction
  | SlateUsageDashboardAction;

export interface SlateUsageUpgradeCta {
  readonly label: string;
  readonly disabled: boolean;
  readonly action: SlateUsageUpgradeAction;
}

/** Exact value assembled by the desktop's account profile. */
export interface SlateUsageSummary {
  readonly isEnterprise: boolean;
  readonly slateUsagePercent: number | null;
  readonly slateUsageResetTimestampMs: number | null;
  readonly hasAvailableUsage: boolean;
  readonly isSlateTrial: boolean;
  readonly hasEndedSlateTrial: boolean;
  readonly hasNonZeroIncludedLimit: boolean;
  readonly canCancelSlateTrial: boolean;
  readonly onDemand: SlateUsageOnDemand | null;
  readonly upgradeCta: SlateUsageUpgradeCta | null;
}
