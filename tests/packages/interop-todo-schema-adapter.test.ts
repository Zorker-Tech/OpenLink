import { test } from "node:test";
import assert from "node:assert/strict";

import { TodoStatus } from "../../source/adapters/interop/proto/generated/agent/v1/todo_tool_pb.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts";
import type { SlateTodoItem } from "../../source/packages/agent/tools/core/todo/contracts.ts";
import {
  fromInteropTodoItem,
  fromInteropTodoStatus,
  fromRedactedInteropTodoItem,
  createSlateTodoItemSerde,
  deserializeSlateTodoItemInterop,
  redactSlateTodoItem,
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

test("todo blobs use Slate fields and reapply the active privacy mode on read", () => {
  const item: SlateTodoItem = {
    id: "todo-1",
    content: "Keep this task",
    status: "in_progress",
    createdAt: 12n,
    updatedAt: 34n,
    dependencies: ["todo-0"],
  };
  const serde = createSlateTodoItemSerde(PrivacyMode.NO_STORAGE);
  const bytes = serde.serialize(redactSlateTodoItem(item, PrivacyMode.NO_STORAGE));
  const json = new TextDecoder().decode(bytes);
  assert.ok(json.startsWith("SLATE-AGENT-TODO\n"));
  assert.deepEqual(serde.getBlobType?.(), { kind: "json", typeName: "slate.agent-todo-item" });
  const decoded = serde.deserialize(bytes);
  if (typeof decoded.content === "string") assert.fail("expected privacy-aware todo content");
  assert.equal(decoded.content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "Keep this task");
  assert.equal(decoded.content.__classification, DataClassification.CODE);
  assert.equal(decoded.status, "in_progress");
  assert.equal(decoded.createdAt, 12n);
  assert.deepEqual(decoded.dependencies, ["todo-0"]);
  assert.equal(deserializeSlateTodoItemInterop(bytes).content, "Keep this task");
});

