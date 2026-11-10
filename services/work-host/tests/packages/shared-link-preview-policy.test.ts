import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as policy from "../../source/shared/link-preview-policy.ts";
import { NON_PUBLIC_HOSTNAME_SUFFIXES, hasNonPublicHostnameSuffix } from "../../source/shared/link-preview-policy.ts";

describe("a link preview's hostname policy", () => {
  it("names the suffixes that only resolve inside a network, and nothing else at runtime", () => {
    assert.deepEqual(Object.keys(policy).sort(), ["NON_PUBLIC_HOSTNAME_SUFFIXES", "hasNonPublicHostnameSuffix"]);
    assert.deepEqual(
      [...NON_PUBLIC_HOSTNAME_SUFFIXES],
      [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".cluster", ".svc", ".arpa", ".onion"],
    );
  });

  it("refuses a name that carries one of the suffixes, and the bare name itself", () => {
    for (const suffix of NON_PUBLIC_HOSTNAME_SUFFIXES) {
      assert.equal(hasNonPublicHostnameSuffix(`printer${suffix}`), true, `printer${suffix}`);
      assert.equal(hasNonPublicHostnameSuffix(suffix.slice(1)), true, `the bare name ${suffix.slice(1)}`);
    }
    assert.equal(hasNonPublicHostnameSuffix("service.cluster"), true);
    assert.equal(hasNonPublicHostnameSuffix("sub.printer.onion"), true);
  });

  it("allows names that merely contain a suffix without ending in it, and the public addresses", () => {
    assert.equal(hasNonPublicHostnameSuffix("example.com"), false);
    assert.equal(hasNonPublicHostnameSuffix("notlocal"), false, "a bare name is only refused when it is the whole label");
    assert.equal(hasNonPublicHostnameSuffix("evil-local"), false);
    assert.equal(hasNonPublicHostnameSuffix("local.example"), false);
    assert.equal(hasNonPublicHostnameSuffix(""), false);
    assert.equal(hasNonPublicHostnameSuffix("127.0.0.1"), false);
    assert.equal(hasNonPublicHostnameSuffix("192.168.1.1"), false);
  });

  it("compares the name as written: case and a trailing dot are not the suffix", () => {
    assert.equal(hasNonPublicHostnameSuffix("printer.local"), true);
    assert.equal(hasNonPublicHostnameSuffix("Printer.Local"), false);
    assert.equal(hasNonPublicHostnameSuffix("printer.local."), false);
  });
});
