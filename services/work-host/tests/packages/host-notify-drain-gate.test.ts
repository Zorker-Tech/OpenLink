import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createNotifyDrainGate, NOTIFY_DRAIN_FLOOR_MS, NOTIFY_SAFETY_POLL_MS } from '../../source/host/notifications/notify-drain-gate.ts';

describe('the notify drain gate', () => {
  it('reads the host defaults: an unstated connection is down, and an unstated safety poll is on', () => {
    assert.equal(NOTIFY_SAFETY_POLL_MS, 120_000);
    assert.equal(NOTIFY_DRAIN_FLOOR_MS, 4_000);
    let now = 0;
    const withoutConnection = createNotifyDrainGate({ now: () => now });
    withoutConnection.recordPoll();
    now = 1_000;
    assert.equal(withoutConnection.shouldDrain({ hasOwedWork: false }), true, 'an unstated connection drains at once');
    const withConnection = createNotifyDrainGate({ now: () => now, isConnected: () => true });
    withConnection.recordPoll();
    now = 2_000;
    assert.equal(withConnection.shouldDrain({ hasOwedWork: false }), false, 'nothing is due yet');
    now = 2_000 + NOTIFY_SAFETY_POLL_MS;
    assert.equal(withConnection.shouldDrain({ hasOwedWork: false }), true, 'an unstated safety poll is on');
  });

  it('drains at once when there is owed work, when the connection is down, or before any poll', () => {
    let now = 0;
    const gate = createNotifyDrainGate({ now: () => now, isConnected: () => true, isSafetyPollEnabled: () => true });
    assert.equal(gate.shouldDrain({ hasOwedWork: true }), true);
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), true, 'no poll yet');
    gate.recordPoll();
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), false, 'nothing new, nothing owed, just polled');
    now = 1_000;
    assert.equal(gate.shouldDrain({ hasOwedWork: true }), true, 'owed work drains');
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), false, 'nothing is due yet');
    // A clock that went backwards gives a negative wait, which is not due either.
    now = -5;
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), false, 'a negative wait is not due');
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
    now = 0;
    gate.reset();
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), true, 'a reset at a small clock still drains at once');
  });

  it('clears a notification that was drained on a later poll, but not one recorded after the drain', () => {
    let now = 1_000_000;
    const gate = createNotifyDrainGate({ now: () => now, isConnected: () => true, isSafetyPollEnabled: () => true });
    gate.recordPoll();
    gate.recordNotify();
    now += NOTIFY_DRAIN_FLOOR_MS;
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), true);
    gate.recordPoll();
    now += NOTIFY_DRAIN_FLOOR_MS;
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), false, 'a drained notification does not keep the floor armed');
    gate.recordNotify();
    gate.recordPoll();
    now += NOTIFY_DRAIN_FLOOR_MS;
    assert.equal(gate.shouldDrain({ hasOwedWork: false }), true, 'a notification recorded after the drain is still pending');
  });
});