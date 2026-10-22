import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildWebSearchYearGuidance,
  getIsoDateYearString,
} from "../../source/packages/utils/search-year-guidance.ts";

describe("the year of a prompt date", () => {
  it("is the first four characters of a date that has the ISO shape", () => {
    assert.equal(getIsoDateYearString("2026-10-22"), "2026");
    assert.equal(getIsoDateYearString("0000-00-00"), "0000");
    assert.equal(getIsoDateYearString("abcd-ef-gh"), "abcd", "only the shape is checked, not the digits");
    assert.equal(getIsoDateYearString("    -  -  "), "    ", "spaces are shaped like digits to this reader");
  });

  it("refuses a text that does not have the shape, naming what it got", () => {
    for (const dateString of ["2026-10-2", "2026-10-222", "", "2026/10-22", "2026-10/22", "2026-1/0-22"]) {
      assert.throws(() => getIsoDateYearString(dateString), {
        name: "Error",
        message: "Expected ISO date string, got: " + dateString,
      }, dateString);
    }
  });
});

describe("the guidance a web search is given", () => {
  it("states today's date and both the right and the wrong year", () => {
    assert.equal(
      buildWebSearchYearGuidance("2026-10-22"),
      "IMPORTANT - Use the correct year in search queries:\n" +
        "- Today's date is 2026-10-22. You MUST use this year when searching for recent information, documentation, or current events.\n" +
        '- Example: If today is 2026-10-22 and the user asks for "latest React docs", search for "React documentation 2026", NOT "React documentation 2025"',
    );
  });

  it("writes the previous year as the year before, across the edges", () => {
    assert.equal(buildWebSearchYearGuidance("0000-01-01").includes('"React documentation -1"'), true);
    assert.equal(buildWebSearchYearGuidance("9999-12-31").includes('"React documentation 9998"'), true);
    assert.equal(buildWebSearchYearGuidance("0100-01-01").includes('"React documentation 99"'), true, "the number is read, not kept as text");
  });

  it("keeps a year that is not a number as it is", () => {
    const guidance = buildWebSearchYearGuidance("abcd-10-22");
    assert.equal(guidance.includes('"React documentation abcd"'), true);
    assert.equal(guidance.includes('"React documentation abcd"'), true);
    assert.equal(guidance.includes('NOT "React documentation abcd"'), true);
  });

  it("reads the previous year in base ten, so a hex-looking year is not one", () => {
    // parseInt without a radix would read 0x10 as sixteen.
    assert.equal(buildWebSearchYearGuidance("0x10-01-01").includes('"React documentation -1"'), true);
  });

  it("refuses a prompt date without the shape", () => {
    assert.throws(() => buildWebSearchYearGuidance("yesterday"), { message: "Expected ISO date string, got: yesterday" });
  });
});