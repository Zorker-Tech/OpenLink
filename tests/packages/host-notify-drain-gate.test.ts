import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createNotifyDrainGate, NOTIFY_DRAIN_FLOOR_MS, NOTIFY_SAFETY_POLL_MS } from '../../source/host/notifications/notify-drain-gate.ts';
describe('the notify drain gate', () => {
  it('drains at once when there is owed work, when the connection is down, or before any poll', () => {
    assert.equal(NOTIFY_SAFETY_POLL_MS, 120_000);
    assert.equal(NOTIFY_DRAIN_FLOOR_MS, 4_000);
    let now = 0; let connected = true; let safety = true;
    const gate = createNotifyDrainGate({ now: () => now, isConnected: () => connected, isSafetyPollEnabled: () => safety });
    assert.equal(gate.shouldDrain({ hasOwedWork: true }), true);
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), true, 'no poll yet');
    gate.recordPoll();
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), false, 'nothing new, nothing owed, just polled');
    connected = false;
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), true);
    connected = true;
    safety = false;
    now = NOTIFY_SAFETY_POLL_MS;
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), false, 'the safety poll is off');
  });
  it('drains a recorded notification after the floor, and the safety poll after its own wait', () => {
    let now = 1_000_000;
    const gate = createNotifyDrainGate({ now: () => now, isConnected: () => true, isSafetyPollEnabled: () => true });
    gate.recordPoll();
    gate.recordNotify();
    now += NOTIFY_DRAIN_FLOOR_MS - 1;
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), false);
    now += 1;
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), true, 'after the floor');
    gate.recordPoll();
    now += NOTIFY_SAFETY_POLL_MS;
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), true, 'after the safety poll wait');
    gate.reset();
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), true, 'after a reset');
  });
  it('clears a drained notification on a later poll, but not one recorded after the drain', () => {
    let now = 0;
    const gate = createNotifyDrainGate({ now: () => now, isConnected: () => true, isSafetyPollEnabled: () => true });
    gate.recordPoll();
    gate.recordNotify();
    now += NOTIFY_DRAIN_FLOOR_MS;
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), true);
    gate.recordPoll();
    // The floor no longer forces a drain: the notification was drained and the poll cleared it.
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), false);
    gate.recordNotify();
    gate.recordPoll();
    // The notification was recorded but not drained by that poll's drain call, so it is still pending.
    now += NOTIFY_DRAIN_FLOOR_MS;
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), true);
  });
});
