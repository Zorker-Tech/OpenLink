import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diskPressureReport, severityOf } from "../../source/host/telemetry/disk-pressure-telemetry.ts";

describe("how a disk pressure is reported", () => {
  it("is an error when it is hard and a warning when it is soft", () => {
    assert.equal(severityOf("hard"), "error");
    assert.equal(severityOf("soft"), "warn");
  });

  it("is information for a level this build does not raise, and for a name every object has", () => {
    for (const level of ["medium", "", "HARD", "toString", "__proto__", "constructor"]) assert.equal(severityOf(level), "info", level);
  });
});

describe("what the backend is told about it", () => {
  it("carries the volume, the level and the room that is left", () => {
    assert.deepEqual(diskPressureReport({ level: "hard", volume: "/", trigger: "watch", totalBytes: 100, availableBytes: 5, usedPercent: 95 }), {
      level: "error",
      metadata: {
        volume: "/",
        pressure_level: "hard",
        trigger: "watch",
        total_bytes: "100",
        available_bytes: "5",
        used_percent: "95.0",
      },
    });
  });

  it("sends the numbers as text, with the percentage to one decimal", () => {
    const report = diskPressureReport({ level: "soft", volume: "v", trigger: "t", totalBytes: 1, availableBytes: 1, usedPercent: 99.99 });
    assert.deepEqual([report.metadata.total_bytes, report.metadata.available_bytes, report.metadata.used_percent], ["1", "1", "100.0"]);
  });
});
