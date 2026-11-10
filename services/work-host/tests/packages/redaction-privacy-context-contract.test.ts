import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DataClassification } from "../../source/packages/redaction/classification.ts";
import {
  privacyContextFromMode,
  resolveEnforceRedaction,
  setRedactionEnforcementGate,
  toPrivacyContext,
  type PrivacyContext,
} from "../../source/packages/redaction/privacy-context.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";

describe("redaction context resolution", () => {
  it("uses an explicit true or false before consulting the process gate", () => {
    let gateReads = 0;
    setRedactionEnforcementGate(() => { gateReads += 1; return true; });
    try {
      assert.equal(resolveEnforceRedaction({ privacyMode: PrivacyMode.NO_STORAGE, enforceRedaction: false }, DataClassification.CREDENTIALS), false);
      assert.equal(resolveEnforceRedaction({ privacyMode: PrivacyMode.UNSPECIFIED, enforceRedaction: true }, DataClassification.SAFE), true);
      assert.equal(gateReads, 0);
    } finally {
      setRedactionEnforcementGate(() => undefined);
    }
  });

  it("consults the process gate only for a specified privacy mode", () => {
    const modes: PrivacyMode[] = [];
    setRedactionEnforcementGate(() => { modes.push(PrivacyMode.NO_STORAGE); return true; });
    try {
      assert.equal(resolveEnforceRedaction({ privacyMode: PrivacyMode.UNSPECIFIED }, DataClassification.CODE), false);
      assert.deepEqual(modes, []);
      assert.equal(resolveEnforceRedaction({ privacyMode: PrivacyMode.NO_STORAGE }, DataClassification.SAFE), true);
      assert.equal(resolveEnforceRedaction({ privacyMode: PrivacyMode.NO_STORAGE }, DataClassification.CREDENTIALS), true);
      assert.deepEqual(modes, [PrivacyMode.NO_STORAGE, PrivacyMode.NO_STORAGE]);
    } finally {
      setRedactionEnforcementGate(() => undefined);
    }
  });

  it("treats an absent or abstaining process decision as no enforcement", () => {
    setRedactionEnforcementGate(() => undefined);
    assert.equal(resolveEnforceRedaction({ privacyMode: PrivacyMode.NO_STORAGE }, DataClassification.CODE), false);
    setRedactionEnforcementGate(() => false);
    assert.equal(resolveEnforceRedaction({ privacyMode: PrivacyMode.NO_STORAGE }, DataClassification.CODE), false);
    setRedactionEnforcementGate(() => undefined);
  });

  it("keeps a bare mode small and preserves an existing context by identity", () => {
    assert.deepEqual(privacyContextFromMode(PrivacyMode.NO_TRAINING), { privacyMode: PrivacyMode.NO_TRAINING });
    assert.deepEqual(privacyContextFromMode(PrivacyMode.NO_STORAGE, true), {
      privacyMode: PrivacyMode.NO_STORAGE,
      enforceRedaction: true,
    });

    const context: PrivacyContext = { privacyMode: PrivacyMode.NO_STORAGE, enforceRedaction: false };
    assert.equal(toPrivacyContext(context), context);
    assert.deepEqual(toPrivacyContext(PrivacyMode.UNSPECIFIED), { privacyMode: PrivacyMode.UNSPECIFIED });
  });
});
