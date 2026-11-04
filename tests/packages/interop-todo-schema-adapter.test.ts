import { test } from "node:test";
import assert from "node:assert/strict";

import { TodoStatus } from "../../source/adapters/interop/proto/generated/agent/v1/todo_tool_pb.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";
import type { SlateTodoItem } from "../../source/packages/agent/tools/core/todo/contracts.ts";
import {
  fromInteropTodoItem,
  fromInteropTodoStatus,
  fromRedactedInteropTodoItem,
  toInteropTodoItem,
  toInteropTodoStatus,
  toRedactedInteropTodoItem,
  type RedactedInteropTodoItem,
} from "../../source/adapters/interop/agent/todo-schema-adapter.ts";

test("all task statuses map between Slate and the stored enum", () => {
  const cases = [
    [TodoStatus.UNSPECIFIED, "unspecified"],
    [TodoStatus.PENDING, "pending"],
    [TodoStatus.IN_PROGRESS, "in_progress"],
    [TodoStatus.COMPLETED, "completed"],
    [TodoStatus.CANCELLED, "cancelled"],
  ] as const;
  for (const [wireStatus, slateStatus] of cases) {
    assert.equal(fromInteropTodoStatus(wireStatus), slateStatus);
    assert.equal(toInteropTodoStatus(slateStatus), wireStatus);
  }
});

test("a task round trip preserves timestamps and dependency links", () => {
  const item: SlateTodoItem = {
    id: "task-2",
    content: "Review the boundary",
    status: "in_progress",
    createdAt: 42n,
    updatedAt: 84n,
    dependencies: ["task-1"],
  };
  assert.deepEqual(fromInteropTodoItem(toInteropTodoItem(item)), item);
});

test("stored redaction is decoded only at the adapter boundary", () => {
  const item: SlateTodoItem = {
    id: "task-3",
    content: "Keep private text intact",
    status: "completed",
    createdAt: 10n,
    updatedAt: 11n,
  };
  const stored = toRedactedInteropTodoItem(item, PrivacyMode.NO_STORAGE) as RedactedInteropTodoItem;
  assert.deepEqual(fromRedactedInteropTodoItem(stored), item);
});
