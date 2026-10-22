import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/host/runner/site-visit-tracking.ts';
describe('tracking the sites an agent visits', () => {
  it('reads the host of a URL without the www prefix', () => {
    assert.equal(mod.visitedSiteHost('https://www.example.com/x'), 'example.com');
    assert.equal(mod.visitedSiteHost('https://sub.www.example.com'), 'sub.www.example.com');
    assert.equal(mod.visitedSiteHost('https://example.com:8443'), 'example.com');
    assert.equal(mod.visitedSiteHost('not a url'), undefined);
    assert.equal(mod.visitedSiteHost('file:///tmp/x'), undefined);
    assert.equal(mod.visitedSiteHost('https://'), undefined);
  });
  it('records every action and only reports the sites of browser navigations', () => {
    const events: string[] = [];
    const auditor = { record(record: { action: { kind: string } }) { events.push('audit:' + record.action.kind); } };
    const wrapped = mod.withSiteVisitTracking(auditor as never, (visit, record) => events.push('visit:' + visit.host + ':' + (record as unknown as { id: number }).id));
    wrapped.record({ action: { kind: 'browserNavigation', url: 'https://www.example.com' }, id: 1 } as never);
    wrapped.record({ action: { kind: 'shell', url: 'https://example.com' }, id: 2 } as never);
    wrapped.record({ action: { kind: 'browserNavigation', url: 42 }, id: 3 } as never);
    wrapped.record({ action: { kind: 'browserNavigation', url: 'not a url' }, id: 4 } as never);
    assert.deepEqual(events, ['audit:browserNavigation', 'visit:example.com:1', 'audit:shell', 'audit:browserNavigation', 'audit:browserNavigation']);
  });
});
