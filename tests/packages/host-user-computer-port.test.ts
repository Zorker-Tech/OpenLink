import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/host/ports/user-computer.ts';
import { createSingleUserComputer, DEFAULT_SLATE_COMPUTER_ID } from '../../source/host/ports/user-computer.ts';
describe('the user computer port', () => {
  it('lists one machine with its id, label and connection', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['DEFAULT_SLATE_COMPUTER_ID', 'createSingleUserComputer']);
    assert.equal(DEFAULT_SLATE_COMPUTER_ID, 'this-computer');
    const box = { boxed: true };
    const computer = createSingleUserComputer({ box });
    assert.deepEqual(computer.list(), [{ id: 'this-computer', label: 'this computer', connected: true }]);
    assert.deepEqual(createSingleUserComputer({ box, label: 'my desk' }).list(), [{ id: 'this-computer', label: 'my desk', connected: true }]);
    assert.deepEqual(createSingleUserComputer({ box, isConnected: () => false }).list(), [{ id: 'this-computer', label: 'this computer', connected: false }]);
  });
  it("resolves only the user's own computer, and only while it is connected", () => {
    const box = { boxed: true };
    const computer = createSingleUserComputer({ box });
    const resolved = computer.resolve('this-computer');
    assert.equal(resolved?.id, 'this-computer');
    assert.equal(resolved?.label, 'this computer');
    assert.equal(resolved?.box, box, 'the box is handed back as given');
    const labelled = createSingleUserComputer({ box, label: 'my desk' }).resolve('this-computer');
    assert.equal(labelled?.label, 'my desk', 'a resolved computer keeps the label it was given');
    assert.equal(computer.resolve('another'), undefined);
    assert.equal(computer.resolve(''), undefined);
    const defaulted = computer.resolve();
    assert.equal(defaulted?.id, 'this-computer', 'no id asked for means the user computer');
    assert.equal(defaulted?.box, box);
    assert.equal(createSingleUserComputer({ box, isConnected: () => false }).resolve('this-computer'), undefined);
  });
  it('probes the connection only when a resolution can use it', () => {
    const box = {};
    const probes: string[] = [];
    const computer = createSingleUserComputer({ box, isConnected: () => { probes.push('probe'); return true; } });
    void computer.resolve('another');
    assert.deepEqual(probes, [], 'a request for another computer needs no connection');
    void computer.resolve();
    assert.deepEqual(probes, ['probe'], 'the request without an id does probe');
  });
});