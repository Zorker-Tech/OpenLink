import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/shared/observability/sentry-privacy-mode.ts';
import { PrivacyMode } from '../../source/packages/redaction/privacy-mode.ts';
describe('the tier a privacy mode may be sent as', () => {
  it('keeps the platform modes and maps them to the crash reporter tiers', () => {
    assert.deepEqual(Object.keys(mod), ['slateSentryPrivacyTierForMode']);
    assert.deepEqual(Object.values(PrivacyMode), [
      'unspecified',
      'no-storage',
      'no-training',
      'usage-data-training-allowed',
      'usage-codebase-training-allowed',
    ]);
    assert.equal(mod.slateSentryPrivacyTierForMode(PrivacyMode.USAGE_DATA_TRAINING_ALLOWED), 'full');
    assert.equal(mod.slateSentryPrivacyTierForMode(PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED), 'full');
    assert.equal(mod.slateSentryPrivacyTierForMode(PrivacyMode.NO_TRAINING), 'scrubbed');
    assert.equal(mod.slateSentryPrivacyTierForMode(PrivacyMode.NO_STORAGE), 'fatal-metadata');
    assert.equal(mod.slateSentryPrivacyTierForMode(PrivacyMode.UNSPECIFIED), 'fatal-metadata');
    assert.equal(mod.slateSentryPrivacyTierForMode(), 'fatal-metadata');
    assert.equal(mod.slateSentryPrivacyTierForMode('unrecognized' as never), 'fatal-metadata');
  });
});
