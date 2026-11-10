import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isKnownTimeZone,
  timeZonePromptSection,
  utcOffsetOf,
} from "../../source/shared/timezone.ts";

const winter = new Date("2026-01-15T12:00:00Z");

describe("a time zone the platform knows", () => {
  it("is one the date machinery accepts, and nothing else", () => {
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kolkata", "Europe/Berlin", "Australia/Eucla"]) {
      assert.equal(isKnownTimeZone(zone), true, zone);
    }
    for (const zone of ["", "Not/AZone", "  "]) assert.equal(isKnownTimeZone(zone), false, zone);
    assert.equal(isKnownTimeZone("utc"), true, "zone names are not case-sensitive to the platform");
  });
});

describe("how far a zone is from UTC", () => {
  it("is written the way a user reads it, with a sign and minutes", () => {
    assert.equal(utcOffsetOf(winter, "UTC"), "UTC+0");
    assert.equal(utcOffsetOf(winter, "America/Los_Angeles"), "UTC-8");
    assert.equal(utcOffsetOf(winter, "Asia/Kolkata"), "UTC+5:30");
    assert.equal(utcOffsetOf(winter, "Europe/Berlin"), "UTC+1");
  });

  it("is nothing for a zone nobody recognizes", () => {
    assert.equal(utcOffsetOf(winter, "Not/AZone"), null);
    assert.equal(utcOffsetOf(winter, ""), null);
  });
});

describe("the time section of a system prompt", () => {
  it("says which clock the user lives on, with the offset it is at now", () => {
    const prompt = timeZonePromptSection("America/Los_Angeles", winter);
    assert.match(prompt, /^## Time\n/);
    assert.equal(prompt.includes("America/Los_Angeles (currently UTC-8)"), true);
    assert.match(prompt, /convert it to the user's zone and label it clearly/);
  });

  it("names the zone without an offset when it has none to give", () => {
    assert.equal(timeZonePromptSection("Not/AZone", winter).includes("Not/AZone"), true);
    assert.equal(timeZonePromptSection("Not/AZone", winter).includes("currently"), false);
  });

  it("is nothing at all when the user has no zone", () => {
    assert.equal(timeZonePromptSection(null), "");
    assert.equal(timeZonePromptSection(undefined), "");
    assert.equal(timeZonePromptSection(""), "");
  });
});
