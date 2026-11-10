/**
 * What an automation schedule accepts, when its next occurrence falls and when it can be described in plain words.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AutomationTrigger } from "../../source/shared/automations.ts";
import {
  MAX_CRON_SEARCH_MINUTES,
  automationAnchor,
  compileCronMatcher,
  computeNextRunAt,
  cronDayMatches,
  cronMatchesWallClock,
  describeSchedule,
  describeTrigger,
  expandCronAlias,
  formatTimestamp,
  getZonedFormatter,
  nextCronRun,
  normalizeSchedule,
  parseCron,
  parseCronField,
  parseEveryIntervalMs,
  splitScheduleTimeZone,
  wallClockOfInstant,
} from "../../source/shared/automation-schedule.ts";

describe("reading an automation schedule", () => {
  it("normalizes spaces and removes an optional named timezone prefix", () => {
    assert.equal(normalizeSchedule("  CRON_TZ=Europe/Berlin   0   9  * * 1-5  "), "CRON_TZ=Europe/Berlin 0 9 * * 1-5");
    assert.deepEqual(splitScheduleTimeZone("TZ=UTC 0 9 * * *"), { schedule: "0 9 * * *", timeZone: "UTC" });
    assert.deepEqual(splitScheduleTimeZone("  0 9 * * *  "), { schedule: "0 9 * * *" });
  });

  it("expands the named cron aliases without changing ordinary expressions", () => {
    assert.deepEqual(
      ["@hourly", "@daily", "@midnight", "@weekly", "@monthly", "@yearly", "@annually"].map(expandCronAlias),
      ["0 * * * *", "0 0 * * *", "0 0 * * *", "0 0 * * 0", "0 0 1 * *", "0 0 1 1 *", "0 0 1 1 *"],
    );
    assert.equal(expandCronAlias("0 9 * * 1-5"), "0 9 * * 1-5");
  });

  it("reads a positive @every interval with only its four supported units", () => {
    assert.deepEqual(
      ["@every 1s", "@EVERY 30 m", "@every 2h", "@every 3d"].map(parseEveryIntervalMs),
      [1_000, 30 * 60_000, 2 * 60 * 60_000, 3 * 86_400_000],
    );
    for (const invalid of ["every 1 m", "@every 0m", "@every -1m", "@every 2 months", "@every 1.5h", "@every 3m extra"]) {
      assert.equal(parseEveryIntervalMs(invalid), null, invalid);
    }
  });

  it("expands cron lists, ranges, wildcard steps and stepped single values", () => {
    assert.deepEqual([...parseCronField("1,3,5", 0, 59) ?? []], [1, 3, 5]);
    assert.deepEqual([...parseCronField("5-12/3", 0, 59) ?? []], [5, 8, 11]);
    assert.deepEqual([...parseCronField("*/15", 0, 59) ?? []], [0, 15, 30, 45]);
    assert.deepEqual([...parseCronField("5/20", 0, 59) ?? []], [5, 25, 45]);
  });

  it("rejects malformed or out-of-range cron fields", () => {
    for (const invalid of ["", "1/2/3", "*/0", "*/-1", "2-1", "-1", "60", "1,,2", ",1", "1-2-3", "1e1", "+1", "x", "1.2"]) {
      assert.equal(parseCronField(invalid, 0, 59), null, invalid);
    }
    assert.equal(parseCronField("1", 1, 12)?.has(1), true);
    assert.equal(parseCronField("13", 1, 12), null);
  });

  it("requires five valid cron fields and maps Sunday seven to Sunday zero", () => {
    const matcher = parseCron("0 9 * * 1-5");
    assert.notEqual(matcher, null);
    assert.deepEqual(
      [matcher?.minute.has(0), matcher?.hour.has(9), matcher?.dayOfWeek.has(1), matcher?.dayOfWeek.has(6)],
      [true, true, true, false],
    );
    assert.equal(parseCron("0 0 * * 7")?.dayOfWeek.has(0), true);
    assert.equal(parseCron("5-7 * * * 5-7")?.dayOfWeek.has(0), true);
    for (const invalid of ["", "0 9 * *", "0 9 * * ", "0 9 * * * extra", "0 24 * * *", "0 0 32 * *"]) {
      assert.equal(parseCron(invalid), null, invalid);
    }
  });
});

describe("matching a wall clock", () => {
  it("uses day-of-month and day-of-week as OR only when both were restricted", () => {
    const both = parseCron("0 9 10 * 1");
    assert.notEqual(both, null);
    assert.equal(cronDayMatches(both!, { year: 2026, month: 3, dayOfMonth: 11, dayOfWeek: 1, hour: 9, minute: 0 }), true);
    assert.equal(cronDayMatches(both!, { year: 2026, month: 3, dayOfMonth: 10, dayOfWeek: 2, hour: 9, minute: 0 }), true);
    assert.equal(cronDayMatches(both!, { year: 2026, month: 3, dayOfMonth: 11, dayOfWeek: 2, hour: 9, minute: 0 }), false);

    const monthDayOnly = parseCron("0 9 10 * *");
    assert.equal(cronDayMatches(monthDayOnly!, { year: 2026, month: 3, dayOfMonth: 10, dayOfWeek: 2, hour: 9, minute: 0 }), true);
    assert.equal(cronDayMatches(monthDayOnly!, { year: 2026, month: 3, dayOfMonth: 11, dayOfWeek: 1, hour: 9, minute: 0 }), false);
  });

  it("matches the minute and hour in addition to the calendar day", () => {
    const matcher = parseCron("15 9 * * 1-5");
    assert.equal(cronMatchesWallClock(matcher!, { year: 2026, month: 1, dayOfMonth: 5, dayOfWeek: 1, hour: 9, minute: 15 }), true);
    assert.equal(cronMatchesWallClock(matcher!, { year: 2026, month: 1, dayOfMonth: 5, dayOfWeek: 1, hour: 9, minute: 16 }), false);
    assert.equal(cronMatchesWallClock(matcher!, { year: 2026, month: 1, dayOfMonth: 4, dayOfWeek: 0, hour: 9, minute: 15 }), false);
  });

  it("caches timezone formatters and falls back to the host clock for invalid zones", () => {
    const utc = getZonedFormatter("UTC");
    assert.notEqual(utc, null);
    assert.equal(getZonedFormatter("UTC"), utc);
    assert.equal(getZonedFormatter("Invalid/Slate-Zone"), null);
    assert.equal(getZonedFormatter("Invalid/Slate-Zone"), null);
    assert.deepEqual(wallClockOfInstant(Date.UTC(2026, 0, 1, 9, 30), "UTC"), {
      year: 2026,
      month: 1,
      dayOfMonth: 1,
      dayOfWeek: 4,
      hour: 9,
      minute: 30,
    });
  });
});

describe("finding the next run", () => {
  it("advances strictly to a later cron minute and counts intervals from the supplied instant", () => {
    const start = Date.UTC(2026, 0, 1, 10, 30, 45);
    assert.equal(computeNextRunAt("0 * * * *", start, "UTC"), Date.UTC(2026, 0, 1, 11, 0));
    assert.equal(computeNextRunAt("@every 15 m", start), start + 15 * 60_000);
    assert.equal(computeNextRunAt("@hourly", Date.UTC(2026, 0, 1, 10, 0), "UTC"), Date.UTC(2026, 0, 1, 11, 0));
  });

  it("uses an explicit schedule timezone ahead of the caller's fallback", () => {
    const after = Date.UTC(2026, 0, 1, 8, 0);
    assert.equal(computeNextRunAt("CRON_TZ=UTC 0 9 * * *", after, "America/Los_Angeles"), Date.UTC(2026, 0, 1, 9, 0));
    assert.equal(compileCronMatcher("CRON_TZ=Invalid/Slate-Zone 0 9 * * *"), null);
  });

  it("skips impossible calendar dates without searching beyond its bound", () => {
    const after = Date.UTC(2026, 0, 1);
    assert.equal(MAX_CRON_SEARCH_MINUTES, 366 * 24 * 60);
    assert.equal(computeNextRunAt("0 0 30 2 *", after), null);
    assert.equal(computeNextRunAt("not a schedule", after), null);
  });

  it("skips a nonexistent spring-forward wall time and recognizes both fall-back occurrences", () => {
    const springAfter = Date.UTC(2026, 2, 8, 6, 0);
    assert.equal(
      computeNextRunAt("CRON_TZ=America/New_York 30 2 * * *", springAfter),
      Date.UTC(2026, 2, 9, 6, 30),
    );

    const autumnAfterFirst = Date.UTC(2026, 10, 1, 5, 15);
    assert.equal(
      computeNextRunAt("CRON_TZ=America/New_York 30 1 * * *", autumnAfterFirst),
      Date.UTC(2026, 10, 1, 5, 30),
    );
    const afterFirstOccurrence = Date.UTC(2026, 10, 1, 5, 30);
    assert.equal(
      computeNextRunAt("CRON_TZ=America/New_York 30 1 * * *", afterFirstOccurrence),
      Date.UTC(2026, 10, 1, 6, 30),
    );
  });

  it("uses the next local midnight when it can skip a day, and the injected wall clock for fixed tests", () => {
    const matcher = compileCronMatcher("0 0 * * *");
    assert.notEqual(matcher, null);
    const after = Date.UTC(2026, 0, 1, 10, 30);
    const expected = Date.UTC(2026, 0, 2, 0, 0);
    assert.equal(nextCronRun(matcher!, after, (date) => wallClockOfInstant(date.getTime(), "UTC")), expected);
  });
});

describe("describing a schedule", () => {
  it("uses singular interval words and human prose for common cron shapes", () => {
    assert.deepEqual(
      ["@every 1 s", "@every 1 m", "@every 1 h", "@every 1 d", "@every 30 m"].map(describeSchedule),
      ["Every second", "Every minute", "Every hour", "Every day", "Every 30 minutes"],
    );
    assert.equal(describeSchedule("0 9 * * 1-5"), "Weekdays at 9:00 AM");
    assert.equal(describeSchedule("@daily"), "Every day at 12:00 AM");
    assert.equal(describeSchedule("0 0 15 * *"), "On the 15th of every month at 12:00 AM");
    assert.equal(describeSchedule("CRON_TZ=UTC 0 9 * * *"), "Every day at 9:00 AM (UTC)");
  });

  it("leaves shapes it cannot explain in their normalized form", () => {
    assert.equal(describeSchedule("1,2,3,4 5 * * *"), "1,2,3,4 5 * * *");
    assert.equal(describeSchedule("  not   a schedule "), "not a schedule");
    assert.equal(describeSchedule("0 0 30 2 *"), "Every February 30 at 12:00 AM");
  });

  it("describes a grouped cron and listener trigger in the same order", () => {
    const trigger: AutomationTrigger = {
      type: "group",
      listeners: [
        { type: "cron", schedule: "@daily" },
        {
          type: "microsoftTeams",
          tenantId: "tenant-1",
          teamId: "team-1",
          teamIds: [],
          channelIds: [],
          messageContains: "",
          messageContainsIsRegex: false,
          blockUnauthenticatedTeamsUsers: false,
        },
      ],
    };
    assert.equal(describeTrigger(trigger), "Every day at 12:00 AM or on a Microsoft Teams message");
  });

  it("formats timestamps safely and anchors interval schedules at the latest run", () => {
    assert.equal(formatTimestamp(null), "never");
    assert.equal(formatTimestamp(Number.NaN), "never");
    assert.equal(formatTimestamp(0, "Invalid/Slate-Zone"), new Date(0).toLocaleString());
    assert.equal(automationAnchor({ createdAt: 100, lastRunAt: 500 }), 500);
    assert.equal(automationAnchor({ createdAt: 100, lastRunAt: null }), 100);
    assert.equal(automationAnchor({ createdAt: 100 }), 100);
  });
});
