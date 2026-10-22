import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/shared/observability/sentry-privacy-mode.ts';
describe('the tier a privacy mode may be sent as', () => {
  it('keeps the platform modes and maps them to the crash reporter tiers', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['PrivacyMode', 'slateSentryPrivacyTierForMode']);
    assert.equal(mod.PrivacyMode.UNSPECIFIED, 0);
    assert.equal(mod.PrivacyMode.NO_STORAGE, 1);
    assert.equal(mod.PrivacyMode.NO_TRAINING, 2);
    assert.equal(mod.PrivacyMode.USAGE_DATA_TRAINING_ALLOWED, 3);
    assert.equal(mod.PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED, 4);
    assert.equal(mod.PrivacyMode[3], 'USAGE_DATA_TRAINING_ALLOWED');
    assert.equal(mod.slateSentryPrivacyTierForMode(mod.PrivacyMode.USAGE_DATA_TRAINING_ALLOWED), 'full');
    assert.equal(mod.slateSentryPrivacyTierForMode(mod.PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED), 'full');
    assert.equal(mod.slateSentryPrivacyTierForMode(mod.PrivacyMode.NO_TRAINING), 'scrubbed');
    assert.equal(mod.slateSentryPrivacyTierForMode(mod.PrivacyMode.NO_STORAGE), 'fatal-metadata');
    assert.equal(mod.slateSentryPrivacyTierForMode(mod.PrivacyMode.UNSPECIFIED), 'fatal-metadata');
    assert.equal(mod.slateSentryPrivacyTierForMode(), 'fatal-metadata');
    assert.equal(mod.slateSentryPrivacyTierForMode(99 as never), 'fatal-metadata');
  });
});
