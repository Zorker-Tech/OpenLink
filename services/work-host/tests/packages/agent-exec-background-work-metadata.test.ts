import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeBackgroundWorkMetadata,
  encodeBackgroundWorkMetadata,
} from "../../source/packages/agent-exec/background-work-metadata.ts";

describe("writing the metadata a background task carries", () => {
  it("writes nothing when there is nothing worth writing", () => {
    assert.equal(encodeBackgroundWorkMetadata({}), undefined);
    for (const blank of ["", " ", "\t\n", "  \t "]) {
      assert.equal(encodeBackgroundWorkMetadata({ title: blank }), undefined, JSON.stringify(blank));
      assert.equal(encodeBackgroundWorkMetadata({ cwd: blank }), undefined, JSON.stringify(blank));
    }
    assert.equal(encodeBackgroundWorkMetadata({ title: 7 } as never), undefined);
    assert.equal(encodeBackgroundWorkMetadata({ startTimeMs: 0 }), undefined);
    assert.equal(encodeBackgroundWorkMetadata({ startTimeMs: -1 }), undefined);
    assert.equal(encodeBackgroundWorkMetadata({ startTimeMs: Number.NaN }), undefined);
    assert.equal(encodeBackgroundWorkMetadata({ startTimeMs: Number.POSITIVE_INFINITY }), undefined);
  });

  it("keeps a title and a directory as they were written, padding included", () => {
    assert.deepEqual(
      encodeBackgroundWorkMetadata({ title: " padded ", cwd: " /tmp/project " }),
      { title: " padded ", cwd: " /tmp/project " },
      "the scan is for emptiness, not for tidying",
    );
    assert.deepEqual(encodeBackgroundWorkMetadata({ title: new String("t") } as never), undefined);
  });

  it("writes a start time as whole milliseconds in a string, in that order", () => {
    assert.deepEqual(encodeBackgroundWorkMetadata({ startTimeMs: 12.7 }), { startTimeMs: "12" });
    assert.deepEqual(encodeBackgroundWorkMetadata({ startTimeMs: 1 }), { startTimeMs: "1" });
    assert.deepEqual(encodeBackgroundWorkMetadata({ startTimeMs: 1e21 }), { startTimeMs: "1e+21" }, "the number's own spelling travels");
    assert.deepEqual(
      Object.keys(encodeBackgroundWorkMetadata({ startTimeMs: 2 } as never) ?? {}),
      ["startTimeMs"],
    );
    assert.deepEqual(
      Object.keys(encodeBackgroundWorkMetadata({ cwd: "/x", title: "t", startTimeMs: 2 }) ?? {}),
      ["title", "cwd", "startTimeMs"],
      "fields travel in the metadata's order, not the caller's",
    );
  });

  it("writes a start time below one millisecond as zero, which reads back as nothing", () => {
    const encoded = encodeBackgroundWorkMetadata({ startTimeMs: 5e-324 });
    assert.deepEqual(encoded, { startTimeMs: "0" });
    assert.deepEqual(decodeBackgroundWorkMetadata(encoded), {});
  });

  it("ignores fields that are not part of the metadata", () => {
    assert.deepEqual(
      encodeBackgroundWorkMetadata({ title: "t", extra: 5, anything: { nested: true } } as never),
      { title: "t" },
    );
  });

  it("refuses a value that is not a record at all", () => {
    for (const wrong of [null, undefined]) {
      assert.throws(() => encodeBackgroundWorkMetadata(wrong as never), TypeError, String(wrong));
    }
  });
});

describe("reading the metadata a background task carried", () => {
  it("reads nothing out of nothing", () => {
    for (const empty of [undefined, null, 42, "title", true, []]) {
      assert.deepEqual(decodeBackgroundWorkMetadata(empty as never), {}, String(empty));
    }
    assert.deepEqual(decodeBackgroundWorkMetadata({}), {});
    assert.deepEqual(decodeBackgroundWorkMetadata({ title: " ", cwd: "\t", startTimeMs: "" }), {});
    assert.deepEqual(decodeBackgroundWorkMetadata({ title: 7, cwd: 7, startTimeMs: 12 }), {}, "a stored field that is not text says nothing");
  });

  it("keeps a title and a directory as they were stored, padding included", () => {
    assert.deepEqual(
      decodeBackgroundWorkMetadata({ title: " padded ", cwd: " /tmp/project " }),
      { title: " padded ", cwd: " /tmp/project " },
    );
  });

  it("reads a start time only from text that parses to a positive finite number, and reads it whole", () => {
    assert.deepEqual(decodeBackgroundWorkMetadata({ startTimeMs: "12" }), { startTimeMs: 12 });
    assert.deepEqual(decodeBackgroundWorkMetadata({ startTimeMs: "1.9" }), { startTimeMs: 1 });
    assert.deepEqual(decodeBackgroundWorkMetadata({ startTimeMs: " 5 " }), { startTimeMs: 5 });
    assert.deepEqual(decodeBackgroundWorkMetadata({ startTimeMs: "1e3" }), { startTimeMs: 1000 });
    assert.deepEqual(decodeBackgroundWorkMetadata({ startTimeMs: "0x10" }), { startTimeMs: 16 }, "the number reader is the platform's");
    for (const unreadable of ["0", "-3", "abc", "Infinity", " ", ""]) {
      assert.deepEqual(decodeBackgroundWorkMetadata({ startTimeMs: unreadable }), {}, JSON.stringify(unreadable));
    }
  });

  it("keeps the order title, directory, start time whatever order the store kept", () => {
    assert.deepEqual(
      Object.keys(decodeBackgroundWorkMetadata({ startTimeMs: "2", cwd: "/x", title: "t" })),
      ["title", "cwd", "startTimeMs"],
    );
    assert.deepEqual(
      decodeBackgroundWorkMetadata({ startTimeMs: "2", cwd: "/x", title: "t" }),
      { title: "t", cwd: "/x", startTimeMs: 2 },
    );
  });

  it("reads back what it wrote", () => {
    const declared = { title: "searcher", cwd: "/tmp/project", startTimeMs: 1730000000123.9 };
    assert.deepEqual(decodeBackgroundWorkMetadata(encodeBackgroundWorkMetadata(declared) as never), {
      title: "searcher",
      cwd: "/tmp/project",
      startTimeMs: 1730000000123,
    });
  });
});
