import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { FLAGS, type FeatureFlagName } from "../../source/shared/node/experiments/experiment-config.gen.ts";
import {
  FEATURE_FLAG_OVERRIDE_TTL_MS,
  FEATURE_FLAG_OVERRIDES_FILENAME,
  isFlagName,
  SlateFeatureFlagOverrideStore,
} from "../../source/shared/node/experiments/feature-flag-overrides.ts";

const flagNames = Object.keys(FLAGS) as FeatureFlagName[];
const firstFlag = flagNames[0]!;
const secondFlag = flagNames[1]!;
const thirdFlag = flagNames[2]!;
const fourthFlag = flagNames[3]!;

function cacheFixture() {
  const directory = mkdtempSync(join(tmpdir(), "slate-feature-overrides-"));
  return {
    directory,
    path: join(directory, FEATURE_FLAG_OVERRIDES_FILENAME),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe("local feature-flag override behavior", () => {
  it("accepts only names from the bundled flag registry", () => {
    assert.equal(isFlagName(firstFlag), true);
    assert.equal(isFlagName("unknown_flag_name"), false);
  });

  it("expires a saved value at the injected clock boundary and rejects unknown names", () => {
    const fixture = cacheFixture();
    const clock = { value: 10_000 };
    try {
      const store = new SlateFeatureFlagOverrideStore(() => fixture.directory, () => clock.value);
      assert.equal(store.set("unknown_flag_name", true), false);
      assert.equal(store.set(firstFlag, true), true);
      assert.equal(store.read(firstFlag), true);
      clock.value += FEATURE_FLAG_OVERRIDE_TTL_MS;
      assert.equal(store.read(firstFlag), undefined);
    } finally {
      fixture.dispose();
    }
  });

  it("hydrates only known, well-typed, unexpired entries and leaves a malformed file harmless", () => {
    const fixture = cacheFixture();
    try {
      writeFileSync(fixture.path, JSON.stringify({ overrides: {
        [firstFlag]: { value: false, expiresAtMs: 1001 },
        [secondFlag]: { value: true, expiresAtMs: 999 },
        [thirdFlag]: { value: "true", expiresAtMs: 2000 },
        [fourthFlag]: { value: true, expiresAtMs: "2000" },
      } }));
      const store = new SlateFeatureFlagOverrideStore(() => fixture.directory, () => 1000);
      store.hydrateFromDisk();
      assert.equal(store.read(firstFlag), false);
      assert.deepEqual(store.activeRecord(), { [firstFlag]: false });

      writeFileSync(fixture.path, "not json");
      assert.doesNotThrow(() => store.hydrateFromDisk());
      assert.equal(store.read(firstFlag), false);
    } finally {
      fixture.dispose();
    }
  });

  it("persists an atomic snapshot and restores its values and deadlines", async () => {
    const fixture = cacheFixture();
    const clock = { value: 2_000 };
    try {
      const store = new SlateFeatureFlagOverrideStore(() => fixture.directory, () => clock.value);
      store.set(firstFlag, false);
      await store.persist();
      assert.deepEqual(JSON.parse(readFileSync(fixture.path, "utf8")), {
        overrides: { [firstFlag]: { value: false, expiresAtMs: 2_000 + FEATURE_FLAG_OVERRIDE_TTL_MS } },
      });

      const restored = new SlateFeatureFlagOverrideStore(() => fixture.directory, () => clock.value);
      restored.hydrateFromDisk();
      assert.equal(restored.read(firstFlag), false);
    } finally {
      fixture.dispose();
    }
  });

  it("replaces all entries with valid overrides and can reset to bundled defaults", () => {
    const fixture = cacheFixture();
    const clock = { value: 3_000 };
    try {
      const store = new SlateFeatureFlagOverrideStore(() => fixture.directory, () => clock.value);
      store.set(firstFlag, true);
      store.replaceAll({ [firstFlag]: false, unknown: true, invalid: "yes" as unknown as boolean });
      assert.deepEqual(store.activeRecord(), { [firstFlag]: false });
      store.setAllToBundledDefaults();
      const expected = Object.fromEntries(Object.entries(FLAGS).map(([name, flag]) => [name, flag?.default ?? false]));
      assert.deepEqual(store.activeRecord(), expected);
      store.clearAll();
      assert.equal(store.size, 0);
    } finally {
      fixture.dispose();
    }
  });
});
