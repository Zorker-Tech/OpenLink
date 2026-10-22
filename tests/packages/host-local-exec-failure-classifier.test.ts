import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyLocalExecFailure } from "../../source/host/local-exec/local-exec-failure-classifier.ts";

describe("a failed local-exec operation", () => {
  it("is a missing program when a spawn reported ENOENT", () => {
    assert.deepEqual(classifyLocalExecFailure("spawn ENOENT"), { errorClass: "spawn_enoent", errno: "ENOENT" });
    assert.deepEqual(classifyLocalExecFailure("error: spawn ENOENT"), { errorClass: "spawn_enoent", errno: "ENOENT" });
    assert.deepEqual(classifyLocalExecFailure("spawnSync ENOENT"), { errorClass: "spawn_enoent", errno: "ENOENT" }, "the sync spawn form counts too");
  });

  it("is a permission failure when a spawn reported EACCES or EPERM", () => {
    assert.deepEqual(classifyLocalExecFailure("spawn EACCES"), { errorClass: "spawn_permissions", errno: "EACCES" });
    assert.deepEqual(classifyLocalExecFailure("spawnSync EPERM"), { errorClass: "spawn_permissions", errno: "EPERM" });
  });

  it("is an unclassified spawn for any other errno, and still reports the errno", () => {
    assert.deepEqual(classifyLocalExecFailure("spawn E2BIG"), { errorClass: "spawn_other", errno: "E2BIG" });
    assert.deepEqual(classifyLocalExecFailure("spawn ETXTBSY"), { errorClass: "spawn_other", errno: "ETXTBSY" });
    assert.deepEqual(classifyLocalExecFailure("spawn"), { errorClass: "spawn_other" }, "a spawn without an errno is still a spawn");
  });

  it("is other when the failure did not come from spawning", () => {
    assert.deepEqual(classifyLocalExecFailure(""), { errorClass: "other" });
    assert.deepEqual(classifyLocalExecFailure("gateway refused the request"), { errorClass: "other" });
    assert.deepEqual(classifyLocalExecFailure("ENOENT"), { errorClass: "other", errno: "ENOENT" }, "an errno outside a spawn is reported but does not classify the failure");
    assert.deepEqual(classifyLocalExecFailure("spawned something"), { errorClass: "other" }, "'spawned' is not the spawn call");
  });

  it("reads the mention case-insensitively, and the errno token only in capitals", () => {
    assert.deepEqual(classifyLocalExecFailure("Spawn EACCES"), { errorClass: "spawn_permissions", errno: "EACCES" });
    assert.deepEqual(classifyLocalExecFailure("SPAWN EPERM"), { errorClass: "spawn_permissions", errno: "EPERM" });
    assert.deepEqual(classifyLocalExecFailure("spawn enoent"), { errorClass: "spawn_other" }, "a lowercase errno is not the token");
  });

  it("takes the first errno token and keeps the whole answer small and plain", () => {
    assert.deepEqual(classifyLocalExecFailure("spawn EACCES and EPERM"), { errorClass: "spawn_permissions", errno: "EACCES" });
    const answer = classifyLocalExecFailure("spawn ENOENT");
    assert.deepEqual(Object.keys(answer), ["errorClass", "errno"]);
  });
});
