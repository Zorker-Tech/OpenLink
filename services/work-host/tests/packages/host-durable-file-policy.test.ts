import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOX_STORE_SLATE_DATA_EXCLUDED_FILE_NAMES,
  SLATE_ACK_OBLIGATIONS_FILE_NAME,
  SLATE_DISK_PRESSURE_REMINDERS_FILE_NAME,
  SLATE_PENDING_WAKE_FILE_NAME,
  SLATE_UPGRADE_RESUME_FILE_NAME,
  SLATE_XUSER_TURN_DEDUPE_FILE_NAME,
} from "../../source/host/durable-file-policy.ts";

describe("the host-owned files a box store excludes", () => {
  it("are named by the files the host actually keeps", () => {
    assert.equal(SLATE_UPGRADE_RESUME_FILE_NAME, "host-upgrade-resume.json");
    assert.equal(SLATE_ACK_OBLIGATIONS_FILE_NAME, "ack-obligations.json");
    assert.equal(SLATE_PENDING_WAKE_FILE_NAME, "host-pending-wakes.json");
    assert.equal(SLATE_XUSER_TURN_DEDUPE_FILE_NAME, "host-xuser-turn-nonces.json");
    assert.equal(SLATE_DISK_PRESSURE_REMINDERS_FILE_NAME, "host-disk-pressure-reminders.json");
  });

  it("are listed in one excluded list, in that order, with nothing else", () => {
    assert.deepEqual([...BOX_STORE_SLATE_DATA_EXCLUDED_FILE_NAMES], [
      SLATE_UPGRADE_RESUME_FILE_NAME,
      SLATE_ACK_OBLIGATIONS_FILE_NAME,
      SLATE_PENDING_WAKE_FILE_NAME,
      SLATE_XUSER_TURN_DEDUPE_FILE_NAME,
      SLATE_DISK_PRESSURE_REMINDERS_FILE_NAME,
    ]);
    assert.equal(BOX_STORE_SLATE_DATA_EXCLUDED_FILE_NAMES.length, 5);
  });
});
