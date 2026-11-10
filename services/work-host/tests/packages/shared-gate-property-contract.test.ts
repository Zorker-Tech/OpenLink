import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  pinExperimentsDiagnosticsReporter,
} from "../../source/shared/node/experiments/experiments-diagnostics.ts";
import { MutableGateProperty } from "../../source/shared/node/experiments/gate-property.ts";

describe("mutable gate property contract", () => {
  it("notifies in subscription order only when the value changes", () => {
    const gate = new MutableGateProperty(false);
    const events: string[] = [];
    const removeSecond = gate.subscribe((value) => events.push(`second:${value}`));
    gate.subscribe((value) => events.push(`third:${value}`));

    gate.set(false);
    assert.deepEqual(events, []);
    gate.set(true);
    assert.deepEqual(events, ["second:true", "third:true"]);
    removeSecond();
    gate.set(false);
    assert.deepEqual(events, ["second:true", "third:true", "third:false"]);
    assert.equal(gate.get(), false);
  });

  it("reports listener failures without exposing error details or stopping later listeners", () => {
    pinExperimentsDiagnosticsReporter(null);
    const reports: Array<Record<string, unknown>> = [];
    pinExperimentsDiagnosticsReporter((report) => reports.push(report));
    try {
      const gate = new MutableGateProperty(false);
      const observed: boolean[] = [];
      gate.subscribe(() => { throw new TypeError("private listener detail"); });
      gate.subscribe((value) => observed.push(value));

      gate.set(true);

      assert.deepEqual(reports, [{ kind: "gate_listener_failed", errorClass: "TypeError" }]);
      assert.deepEqual(observed, [true]);
    } finally {
      pinExperimentsDiagnosticsReporter(null);
    }
  });

  it("clears every listener", () => {
    const gate = new MutableGateProperty(false);
    const observed: boolean[] = [];
    gate.subscribe((value) => observed.push(value));
    gate.clearListeners();
    gate.set(true);
    assert.deepEqual(observed, []);
  });
});
