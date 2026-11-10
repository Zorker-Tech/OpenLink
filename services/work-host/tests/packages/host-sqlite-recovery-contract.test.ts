import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { copySalvageableSqliteRows } from "../../source/host/storage/sqlite-recovery.ts";

describe("SQLite recovery helpers", () => {
  it("copies each readable row independently and closes the iterator", () => {
    const rows = [{ id: "one" }, { id: "bad" }, { id: "two" }];
    const calls: string[] = [];
    let index = 0;
    let returned = 0;
    const copied = copySalvageableSqliteRows(
      { prepare: (sql) => {
        assert.equal(sql, "SELECT id");
        return { iterate: () => ({
          next: () => index < rows.length ? { done: false as const, value: rows[index++] } : { done: true as const, value: undefined },
          return: () => { returned += 1; return { done: true as const, value: undefined }; },
        }) };
      } },
      "SELECT id",
      { run: (id) => { calls.push(String(id)); if (id === "bad") throw new Error("unwritable row"); } },
      (row) => [(row as { id: string }).id],
    );

    assert.equal(copied, 2);
    assert.deepEqual(calls, ["one", "bad", "two"]);
    assert.equal(returned, 1);
  });

  it("returns zero when reading cannot start and stops a damaged iterator after its first failure", () => {
    assert.equal(copySalvageableSqliteRows(
      { prepare: () => { throw new Error("table missing"); } },
      "SELECT id",
      { run: () => {} },
      () => [],
    ), 0);

    let nextCalls = 0;
    let returned = 0;
    const copied = copySalvageableSqliteRows(
      { prepare: () => ({ iterate: () => ({
        next: () => {
          nextCalls += 1;
          if (nextCalls === 1) return { done: false as const, value: { id: "first" } };
          throw new Error("damaged page");
        },
        return: () => { returned += 1; return { done: true as const, value: undefined }; },
      }) }) },
      "SELECT id",
      { run: () => {} },
      (row) => [(row as { id: string }).id],
    );
    assert.equal(copied, 1);
    assert.equal(nextCalls, 2);
    assert.equal(returned, 1);
  });
});
