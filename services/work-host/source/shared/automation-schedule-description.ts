import { describeListener, type AutomationTrigger } from "./automations.ts";
import { compileCronMatcher, EVERY_PATTERN, normalizeSchedule, parseEveryIntervalMs } from "./automation-schedule-core.ts";
import type { CronMatcher } from "./automation-schedule-contracts.ts";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface DayDescription {
  readonly opening: string;
  readonly suffix: string | null;
}

type ClockDescription =
  | { readonly kind: "times"; readonly times: string[] }
  | { readonly kind: "interval"; readonly phrase: string; readonly window: string | null };

function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function dayOrdinal(day: number): string {
  let suffix = "th";
  if (day % 100 < 11 || day % 100 > 13) {
    suffix = day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  }
  return `${day}${suffix}`;
}

function sortedValues(values: Set<number>): number[] {
  return [...values].sort((left, right) => left - right);
}

function regularStride(sorted: readonly number[]): number | null {
  if (sorted[0] == null || sorted[1] == null) return null;
  const step = sorted[1] - sorted[0];
  if (step <= 0) return null;
  for (let index = 2; index < sorted.length; index += 1) {
    if ((sorted[index] as number) - (sorted[index - 1] as number) !== step) return null;
  }
  return step;
}

function sameValues(left: Set<number>, right: Set<number>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function describeDays(matcher: CronMatcher): DayDescription | null {
  const everyMonth = matcher.month.size === 12;
  const usesMonthDay = matcher.isDayOfMonthRestricted && matcher.dayOfMonth.size < 31;
  const usesWeekday = matcher.isDayOfWeekRestricted && matcher.dayOfWeek.size < 7;

  if (usesMonthDay && usesWeekday) return null;
  if (usesWeekday) {
    if (!everyMonth) return null;
    if (sameValues(matcher.dayOfWeek, new Set([1, 2, 3, 4, 5]))) {
      return { opening: "Weekdays", suffix: " on weekdays" };
    }
    if (sameValues(matcher.dayOfWeek, new Set([0, 6]))) {
      return { opening: "Weekends", suffix: " on weekends" };
    }

    const days = sortedValues(matcher.dayOfWeek);
    if (days.length > 3) {
      if (regularStride(days) !== 1) return null;
      const span = `${SHORT_DAY_NAMES[days[0] as number]}–${SHORT_DAY_NAMES[days.at(-1) as number]}`;
      return { opening: span, suffix: `, ${span}` };
    }

    const namedDays = joinWords(days.map((day) => DAY_NAMES[day] as string));
    return { opening: `Every ${namedDays}`, suffix: ` on ${namedDays}` };
  }

  if (usesMonthDay) {
    const days = sortedValues(matcher.dayOfMonth);
    if (everyMonth) {
      if (days.length > 3) return null;
      const dates = joinWords(days.map(dayOrdinal));
      return { opening: `On the ${dates} of every month`, suffix: ` on the ${dates} of every month` };
    }
    if (matcher.month.size === 1 && days.length === 1) {
      const month = [...matcher.month][0] as number;
      const date = `${MONTH_NAMES[month - 1]} ${days[0]}`;
      return { opening: `Every ${date}`, suffix: ` on ${date}` };
    }
    return null;
  }

  return everyMonth ? { opening: "Every day", suffix: null } : null;
}

function twelveHourClock(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const hourLabel = hour % 12 === 0 ? 12 : hour % 12;
  return `${hourLabel}:${String(minute).padStart(2, "0")} ${period}`;
}

function describeClock(matcher: CronMatcher): ClockDescription | null {
  const minutes = sortedValues(matcher.minute);
  const hours = sortedValues(matcher.hour);
  const firstMinute = minutes[0];
  const lastMinute = minutes.at(-1);
  const firstHour = hours[0];
  const lastHour = hours.at(-1);
  if (firstMinute == null || lastMinute == null || firstHour == null || lastHour == undefined) return null;

  const everyHour = hours.length === 24;
  if (minutes.length === 1) {
    const suffix = firstMinute === 0 ? "" : ` at :${String(firstMinute).padStart(2, "0")}`;
    if (everyHour) return { kind: "interval", phrase: `Every hour${suffix}`, window: null };
    if (hours.length === 1) return { kind: "times", times: [twelveHourClock(firstHour, firstMinute)] };

    const hourStep = regularStride(hours);
    if (hourStep != null) {
      const cadence = hourStep === 1 ? "Every hour" : `Every ${hourStep} hours`;
      if (firstHour === 0 && lastHour + hourStep > 23) {
        return { kind: "interval", phrase: `${cadence}${suffix}`, window: null };
      }
      if (hourStep === 1 || hours.length > 3) {
        return {
          kind: "interval",
          phrase: cadence,
          window: `${twelveHourClock(firstHour, firstMinute)} – ${twelveHourClock(lastHour, firstMinute)}`,
        };
      }
    }
    return hours.length <= 3
      ? { kind: "times", times: hours.map((hour) => twelveHourClock(hour, firstMinute)) }
      : null;
  }

  const minuteStep = minutes[0] === 0 ? regularStride(minutes) : null;
  const minuteInterval = minuteStep != null && (minutes.at(-1) as number) + minuteStep > 59
    ? minuteStep
    : null;
  let phrase: string;
  if (minuteInterval != null) {
    phrase = minuteInterval === 1 ? "Every minute" : `Every ${minuteInterval} minutes`;
  } else {
    if (minutes.length > 3) return null;
    if (!everyHour && hours.length === 1) {
      return { kind: "times", times: minutes.map((minute) => twelveHourClock(firstHour, minute)) };
    }
    phrase = `Every hour at ${joinWords(minutes.map((minute) => `:${String(minute).padStart(2, "0")}`))}`;
  }

  if (everyHour) return { kind: "interval", phrase, window: null };
  if (!(hours.length === 1 || regularStride(hours) === 1)) return null;
  return {
    kind: "interval",
    phrase,
    window: `${twelveHourClock(firstHour, firstMinute)} – ${twelveHourClock(lastHour, lastMinute)}`,
  };
}

export function describeSchedule(schedule: string): string {
  const normalized = normalizeSchedule(schedule);
  const intervalMs = parseEveryIntervalMs(normalized);
  if (intervalMs != null) {
    const match = EVERY_PATTERN.exec(normalized);
    const amount = match?.[1] ?? "";
    const unit = ({ s: "second", m: "minute", h: "hour", d: "day" } as Record<string, string>)[
      match?.[2]?.toLowerCase() ?? ""
    ] ?? "";
    return amount === "1" ? `Every ${unit}` : `Every ${amount} ${unit}s`;
  }

  const matcher = compileCronMatcher(normalized);
  if (matcher == null) return normalized;
  const days = describeDays(matcher);
  const time = describeClock(matcher);
  if (days == null || time == null) return normalized;

  const phrase = time.kind === "times"
    ? `${days.opening} at ${joinWords(time.times)}`
    : `${time.phrase}${days.suffix ?? ""}${time.window == null ? "" : `, ${time.window}`}`;
  return matcher.timeZone == null ? phrase : `${phrase} (${matcher.timeZone})`;
}

export function describeTrigger(trigger: AutomationTrigger): string {
  const pieces = trigger.type === "group" ? trigger.listeners : [trigger];
  const descriptions = pieces.map((member) =>
    member.type === "cron" ? describeSchedule(member.schedule) : describeListener(member),
  );
  return descriptions
    .map((description, index) => index === 0 ? description : lowerInitial(description))
    .join(" or ");
}

function lowerInitial(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toLowerCase() + value.slice(1);
}
