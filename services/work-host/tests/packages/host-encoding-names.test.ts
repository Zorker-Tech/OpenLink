import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ENCODING_MAPPINGS,
  LATIN1_ENCODING,
  UTF8_BOM_ENCODING,
  UTF8_ENCODING,
  mapToIconvEncoding,
  normalizeEncodingName,
  stripUtf8Bom,
} from "../../source/packages/utils/encoding-names.ts";

describe("an encoding name", () => {
  it("is folded to one of the three names this platform uses, or to its own lowercase", () => {
    assert.equal(normalizeEncodingName("latin-1"), LATIN1_ENCODING);
    assert.equal(normalizeEncodingName("UTF-8"), UTF8_ENCODING);
    assert.equal(normalizeEncodingName("utf-8-bom"), UTF8_BOM_ENCODING);
    assert.equal(normalizeEncodingName("utf-8 bom"), UTF8_BOM_ENCODING);
    assert.equal(normalizeEncodingName("Windows-1252"), "windows-1252");
    assert.equal(normalizeEncodingName(" gbk "), " gbk ", "the padding is the caller's problem, not the name's");
    assert.deepEqual([UTF8_ENCODING, UTF8_BOM_ENCODING, LATIN1_ENCODING], ["utf8", "utf8bom", "latin1"]);
  });

  it("is mapped to the name a decoder knows, and left alone when this build maps nothing for it", () => {
    assert.equal(mapToIconvEncoding("windows-1252"), "cp1252");
    assert.equal(mapToIconvEncoding("iso-8859-15"), "iso885915");
    assert.equal(mapToIconvEncoding("shift_jis"), "shiftjis");
    assert.equal(mapToIconvEncoding("utf8"), "utf8", "a name with no mapping is its own decoder name");
    assert.equal(mapToIconvEncoding("nope"), "nope");
  });

  it("mapped for every encoding the platform claims to read", () => {
    assert.equal(Object.keys(ENCODING_MAPPINGS).length, 40, "every encoding this build maps, and no more");
    for (const [canonical, decoder] of Object.entries(ENCODING_MAPPINGS)) {
      assert.equal(mapToIconvEncoding(canonical), decoder, canonical);
      assert.equal(canonical.includes(" "), false, "a canonical name has no spaces in it");
    }
  });
});

describe("a byte-order mark", () => {
  it("is dropped from the front of a text, and only from the front", () => {
    assert.equal(stripUtf8Bom("\ufeffhello"), "hello");
    assert.equal(stripUtf8Bom("hello"), "hello");
    assert.equal(stripUtf8Bom("\ufeff"), "");
    assert.equal(stripUtf8Bom("a\ufeffb"), "a\ufeffb", "a mark inside the text is content");
  });
});
