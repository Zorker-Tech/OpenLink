import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/host/host-diagnostics.ts';
describe('reporting a host diagnostic', () => {
  it('goes to the reporter that was pinned last, and nowhere when none is pinned', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['pinHostDiagnosticsReporter', 'reportHostDiagnostic']);
    const received: unknown[] = [];
    assert.equal(mod.reportHostDiagnostic({ kind: 'probe' }), undefined, 'unpinned reports go nowhere and still return nothing');
    assert.equal(mod.pinHostDiagnosticsReporter((diagnostic) => received.push(diagnostic)), undefined);
    const first = { kind: 'first' };
    assert.equal(mod.reportHostDiagnostic(first), undefined);
    assert.deepEqual(received, [first]);
    const second = { kind: 'second', extra: 1 };
    mod.pinHostDiagnosticsReporter((diagnostic) => received.push(diagnostic));
    mod.reportHostDiagnostic(second);
    assert.deepEqual(received, [first, second]);
    mod.pinHostDiagnosticsReporter(null);
    mod.reportHostDiagnostic({ kind: 'after-null' });
    assert.deepEqual(received, [first, second]);
  });
});
