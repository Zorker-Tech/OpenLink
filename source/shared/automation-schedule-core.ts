import { MAX_CRON_SEARCH_MINUTES, type CronMatcher, type WallClock } from "./automation-schedule-contracts.ts";

export const EVERY_PATTERN = /^@every\s+(\d+)\s*(s|m|h|d)$/i;

const UNIT_MILLISECONDS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const CRON_ALIASES: Readonly<Record<string, string>> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MILLISECONDS_PER_MINUTE = 60_000;
const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
const formattersByZone = new Map<string, Intl.DateTimeFormat | null>();

export function normalizeSchedule(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export function splitScheduleTimeZone(schedule: string): { schedule: string; timeZone?: string } {
  const normalized = normalizeSchedule(schedule);
  const prefix = /^(?:CRON_TZ|TZ)=(\S+)\s+/.exec(normalized);
  if (prefix == null) return { schedule: normalized };
  return { schedule: normalized.slice(prefix[0].length), timeZone: prefix[1] as string };
}

export function expandCronAlias(schedule: string): string {
  return CRON_ALIASES[schedule.toLowerCase()] ?? schedule;
}

export function parseCronField(field: string, minimum: number, maximum: number): Set<number> | null {
  if (field.length === 0) return null;
  const values = new Set<number>();

  for (const part of field.split(",")) {
    if (part.length === 0) return null;
    const stepParts = part.split("/");
    if (stepParts.length > 2) return null;

    const rangeText = stepParts[0] ?? "";
    const step = stepParts.length === 2 ? Number(stepParts[1]) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;

    let start: number;
    let end: number;
    if (rangeText === "*") {
      start = minimum;
      end = maximum;
    } else if (rangeText.includes("-")) {
      const rangeBounds = rangeText.split("-");
      if (rangeBounds.length !== 2 || !isUnsignedInteger(rangeBounds[0]) || !isUnsignedInteger(rangeBounds[1])) {
        return null;
      }
      start = Number(rangeBounds[0]);
      end = Number(rangeBounds[1]);
    } else {
      if (!isUnsignedInteger(rangeText)) return null;
      start = Number(rangeText);
      end = stepParts.length === 2 ? maximum : start;
    }

    if (
      !Number.isInteger(start)
      || !Number.isInteger(end)
      || start < minimum
      || end > maximum
      || start > end
    ) return null;

    for (let value = start; value <= end; value += step) values.add(value);
  }

  return values.size > 0 ? values : null;
}

function isUnsignedInteger(value: string | undefined): value is string {
  return value !== undefined && /^\d+$/.test(value);
}

export function parseCron(expression: string): CronMatcher | null {
  const fields = expression.split(" ");
  if (fields.length !== 5) return null;

  const [minuteText = "", hourText = "", dayText = "", monthText = "", weekdayText = ""] = fields;
  const minute = parseCronField(minuteText, 0, 59);
  const hour = parseCronField(hourText, 0, 23);
  const dayOfMonth = parseCronField(dayText, 1, 31);
  const month = parseCronField(monthText, 1, 12);
  const rawWeekdays = parseCronField(weekdayText, 0, 7);
  if (minute == null || hour == null || dayOfMonth == null || month == null || rawWeekdays == null) return null;

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek: new Set([...rawWeekdays].map((day) => day === 7 ? 0 : day)),
    isDayOfMonthRestricted: dayText !== "*",
    isDayOfWeekRestricted: weekdayText !== "*",
  };
}

export function cronDayMatches(matcher: CronMatcher, wall: WallClock): boolean {
  if (!matcher.month.has(wall.month)) return false;
  const monthDayMatches = matcher.dayOfMonth.has(wall.dayOfMonth);
  const weekDayMatches = matcher.dayOfWeek.has(wall.dayOfWeek);

  if (matcher.isDayOfMonthRestricted && matcher.isDayOfWeekRestricted) {
    return monthDayMatches || weekDayMatches;
  }
  return (!matcher.isDayOfMonthRestricted || monthDayMatches)
    && (!matcher.isDayOfWeekRestricted || weekDayMatches);
}

export function cronMatchesWallClock(matcher: CronMatcher, wall: WallClock): boolean {
  return matcher.minute.has(wall.minute)
    && matcher.hour.has(wall.hour)
    && cronDayMatches(matcher, wall);
}

function localWallClock(date: Date): WallClock {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    dayOfMonth: date.getDate(),
    dayOfWeek: date.getDay(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

export function getZonedFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (formattersByZone.has(timeZone)) return formattersByZone.get(timeZone) ?? null;

  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
  } catch {
    formatter = null;
  }
  formattersByZone.set(timeZone, formatter);
  return formatter;
}

function zonedWallClock(date: Date, formatter: Intl.DateTimeFormat): WallClock {
  const fields: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") fields[part.type] = part.value;
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    dayOfMonth: Number(fields.day),
    dayOfWeek: WEEKDAY_INDEX[fields.weekday ?? ""] ?? 0,
    hour: Number(fields.hour) % 24,
    minute: Number(fields.minute),
  };
}

export function nextCronRun(
  matcher: CronMatcher,
  afterMs: number,
  readWallClock: (date: Date) => WallClock,
): number | null {
  let instant = Math.floor(afterMs / MILLISECONDS_PER_MINUTE) * MILLISECONDS_PER_MINUTE + MILLISECONDS_PER_MINUTE;
  const endSearchAt = instant + MAX_CRON_SEARCH_MINUTES * MILLISECONDS_PER_MINUTE;

  while (instant < endSearchAt) {
    const wall = readWallClock(new Date(instant));
    if (cronMatchesWallClock(matcher, wall)) return instant;
    if (cronDayMatches(matcher, wall)) {
      instant += MILLISECONDS_PER_MINUTE;
      continue;
    }

    const minutesToMidnight = (23 - wall.hour) * 60 + (60 - wall.minute);
    const midnightCandidate = instant + minutesToMidnight * MILLISECONDS_PER_MINUTE;
    const nextDayWall = readWallClock(new Date(midnightCandidate));
    if (
      nextDayWall.year === wall.year
      && nextDayWall.month === wall.month
      && nextDayWall.dayOfMonth === wall.dayOfMonth
    ) {
      instant = midnightCandidate;
      continue;
    }

    const skippedMinutes = Math.min(nextDayWall.hour * 60 + nextDayWall.minute, minutesToMidnight - 1);
    instant = midnightCandidate - skippedMinutes * MILLISECONDS_PER_MINUTE;
  }
  return null;
}

export function parseEveryIntervalMs(schedule: string): number | null {
  const matched = EVERY_PATTERN.exec(schedule.trim());
  if (matched == null) return null;
  const amount = Number(matched[1]);
  const unit = matched[2]?.toLowerCase() ?? "";
  const unitDuration = UNIT_MILLISECONDS[unit];
  if (!Number.isFinite(amount) || amount <= 0 || unitDuration == null) return null;
  return amount * unitDuration;
}

export function compileCronMatcher(schedule: string): CronMatcher | null {
  const parsedSchedule = splitScheduleTimeZone(schedule);
  const matcher = parseCron(expandCronAlias(parsedSchedule.schedule));
  if (matcher == null || parsedSchedule.timeZone == null) return matcher;
  if (getZonedFormatter(parsedSchedule.timeZone) == null) return null;
  return { ...matcher, timeZone: parsedSchedule.timeZone };
}

export function wallClockOfInstant(instantMs: number, timeZone?: string): WallClock {
  const formatter = timeZone === undefined ? null : getZonedFormatter(timeZone);
  const date = new Date(instantMs);
  return formatter == null ? localWallClock(date) : zonedWallClock(date, formatter);
}

export function formatTimestamp(instantMs: number | null | undefined, timeZone?: string): string {
  if (instantMs == null || !Number.isFinite(instantMs)) return "never";
  try {
    return new Date(instantMs).toLocaleString(undefined, timeZone === undefined ? {} : { timeZone });
  } catch {
    return new Date(instantMs).toLocaleString();
  }
}

export function computeNextRunAt(schedule: string, afterMs: number, fallbackTimeZone?: string): number | null {
  const normalized = normalizeSchedule(schedule);
  const intervalMs = parseEveryIntervalMs(normalized);
  if (intervalMs != null) return afterMs + intervalMs;

  const matcher = compileCronMatcher(normalized);
  if (matcher == null) return null;
  const zone = matcher.timeZone ?? fallbackTimeZone;
  const formatter = zone === undefined ? null : getZonedFormatter(zone);
  const readWallClock = formatter === null
    ? localWallClock
    : (date: Date) => zonedWallClock(date, formatter);
  return nextCronRun(matcher, afterMs, readWallClock);
}

export function automationAnchor(automation: { readonly createdAt: number; readonly lastRunAt?: number | null }): number {
  return automation.lastRunAt ?? automation.createdAt;
}
