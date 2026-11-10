export const MAX_CRON_SEARCH_MINUTES = 366 * 24 * 60;

export interface CronMatcher {
  readonly minute: Set<number>;
  readonly hour: Set<number>;
  readonly dayOfMonth: Set<number>;
  readonly month: Set<number>;
  readonly dayOfWeek: Set<number>;
  readonly isDayOfMonthRestricted: boolean;
  readonly isDayOfWeekRestricted: boolean;
  readonly timeZone?: string;
}

export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly dayOfMonth: number;
  readonly dayOfWeek: number;
  readonly hour: number;
  readonly minute: number;
}
