import assert from "node:assert/strict"
import { test } from "node:test"

import { isSameBoxMigrationOperation, parseBoxMigrationOperationId } from "../../source/shared/box-migration.ts"

test("migration ids accept non-empty strings without trimming or coercion", () => {
  assert.deepEqual(parseBoxMigrationOperationId("op-1"), { value: "op-1" })
  assert.deepEqual(parseBoxMigrationOperationId(" op-1 "), { value: " op-1 " })
  assert.deepEqual(parseBoxMigrationOperationId(" "), { value: " " })
  for (const value of ["", 0, null, undefined, {}, new String("op-1")]) {
    assert.equal(parseBoxMigrationOperationId(value), null)
  }
})

test("migration identity is exact string equality and absent operations never match", () => {
  assert.equal(isSameBoxMigrationOperation({ value: "op-1" }, { value: "op-1" }), true)
  assert.equal(isSameBoxMigrationOperation({ value: "op-1" }, { value: " op-1 " }), false)
  assert.equal(isSameBoxMigrationOperation({ value: "op-1" }, { value: "op-2" }), false)
  assert.equal(isSameBoxMigrationOperation(null, { value: "op-1" }), false)
  assert.equal(isSameBoxMigrationOperation({ value: "op-1" }, undefined), false)
})
