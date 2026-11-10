/**
 * A watched directory, the wallpaper scheduler, the box's secrets and the state backstop.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WatchedDirectory } from "../../source/host/watched-directory.ts";
import { SLATE_WALLPAPER_PLAN_RETRY_MS, SlateWallpaperSchedule } from "../../source/host/extensions/wallpaper/wallpaper-service.ts";
import { BOX_SECRETS_FILENAME, BoxSecretsValidationError, SECRETS_APPLY_WAIT_MS, SECRETS_RETRY_INITIAL_MS } from "../../source/host/extensions/secrets/secrets-service.ts";
import { DEFAULT_MAX_SNAPSHOT_BYTES, isStateBackstopEnabled, SLATE_STATE_BACKSTOP_REL_PATH, STATE_BACKSTOP_DEBOUNCE_MS } from "../../source/host/extensions/state-backstop/state-backstop-service.ts";

describe("a directory the host watches", () => {
  it("is a watcher the host can build", () => {
    assert.equal(typeof WatchedDirectory, "function");
  });
});

describe("the wallpaper scheduler", () => {
  it("waits a minute before trying a plan it could not resolve", () => {
    assert.equal(SLATE_WALLPAPER_PLAN_RETRY_MS, 60_000);
    assert.equal(typeof SlateWallpaperSchedule, "function");
  });
});

describe("the box's secrets", () => {
  it("keeps them in their own file, and says what it waits and how it retries", () => {
    assert.equal(BOX_SECRETS_FILENAME, "box-secrets.json");
    assert.equal(SECRETS_APPLY_WAIT_MS, 5_000);
    assert.equal(SECRETS_RETRY_INITIAL_MS, 1_000);
    assert.equal(new BoxSecretsValidationError("bad").message, "bad");
  });
});

describe("the state backstop", () => {
  it("names where its snapshot lives, how often it runs and how large it may be", () => {
    assert.equal(SLATE_STATE_BACKSTOP_REL_PATH, "state/store.db");
    assert.equal(STATE_BACKSTOP_DEBOUNCE_MS, 5_000);
    assert.equal(DEFAULT_MAX_SNAPSHOT_BYTES, 64 * 1024 * 1024);
    assert.equal(isStateBackstopEnabled({} as NodeJS.ProcessEnv), false);
  });
});
