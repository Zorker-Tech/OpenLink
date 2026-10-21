/**
 * What an account has used, and what is left.
 *
 * Usage arrives from the account's own service and is read into the shape a surface shows: the plan, the limits, what
 * has been spent in the window, and the moment it resets — with a value that is missing or unreadable treated as
 * unknown rather than as zero, since an unknown usage is not an unused one.
 *
 * Everything here is a value contract: the desktop assembles these shapes and the surfaces read them, so the members
 * and their names are the interface. The one runtime value is the allowlist of dashboard actions below, and its type is
 * derived from that list rather than written out beside it.
 */

/** The dashboard actions a surface may ask the account's service to take. */
const DASHBOARD_ACTIONS = ["requestLimitIncrease"] as const;

export type SupportedDashboardAction = (typeof DASHBOARD_ACTIONS)[number];

/** The allowlist a dashboard action is checked against before it is sent. */
export const SUPPORTED_DASHBOARD_ACTIONS: Set<SupportedDashboardAction> = new Set(DASHBOARD_ACTIONS);

export interface DashboardActionRequest {
  readonly action: SupportedDashboardAction;
  readonly args: Readonly<Record<string, string>>;
}

export interface UsageActionResult {
  readonly ok: boolean;
  readonly message: string | null;
}

/**
 * What a weekly allowance has been spent on, when the plan carries an on-demand allowance beside its included one.
 */
export interface SlateWeeklyOnDemandUsage {
  readonly usedCents: number;
  readonly limitCents: number;
}

/** The weekly allowance as a surface reads it: how much is gone, and when the window opens again. */
export interface SlateWeeklyUsage {
  readonly percentUsed: number;
  readonly nextResetMs: number | null;
  readonly hasNonZeroIncludedLimit: boolean;
  readonly onDemand: SlateWeeklyOnDemandUsage | null;
}

/** On-demand spend for the current window, with the limit and reset a plan may not carry at all. */
export interface SlateUsageOnDemand {
  readonly usedCents: number;
  readonly limitCents: number | null;
  readonly resetTimestampMs: number | null;
}

/** An upgrade call to action that opens somewhere. */
export interface SlateUsageOpenUrlAction {
  readonly kind: "open-url";
  readonly url: string;
}

/** An upgrade call to action that performs a dashboard action and says how it went. */
export interface SlateUsageDashboardAction {
  readonly kind: "dashboard-action";
  readonly action: SupportedDashboardAction;
  readonly args: Readonly<Record<string, string>>;
  readonly successMessage: string | null;
}

export type SlateUsageUpgradeAction = SlateUsageOpenUrlAction | SlateUsageDashboardAction;

/** The button a surface shows when the account can still upgrade, and whether it can be pressed. */
export interface SlateUsageUpgradeCta {
  readonly label: string;
  readonly disabled: boolean;
  readonly action: SlateUsageUpgradeAction;
}

/**
 * Everything a surface needs to say about usage in one read: the plan, the window's spend and reset, whether there is
 * any allowance left, and the upgrade the account is offered.
 */
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
