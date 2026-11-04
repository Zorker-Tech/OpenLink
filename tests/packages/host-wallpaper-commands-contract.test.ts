import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMMAND_TIMEOUT_MS,
  SLATE_WALLPAPER_COMMAND,
  SLATE_WALLPAPER_TONE_SCRIPT,
  createBoxWallpaperCommands,
} from "../../source/host/extensions/wallpaper/box-wallpaper-commands.ts";

describe("wallpaper command boundary", () => {
  it("is available only when both installed commands exist", () => {
    const checked: string[] = [];
    const toneMissing = createBoxWallpaperCommands({
      settingsPath: "/settings.json",
      log: () => {},
      exists: (path) => { checked.push(path); return false; },
    });
    assert.equal(toneMissing.isAvailable, false);
    assert.deepEqual(checked, [SLATE_WALLPAPER_TONE_SCRIPT], "the command check short-circuits after the missing tone helper");

    checked.length = 0;
    const paintMissing = createBoxWallpaperCommands({
      settingsPath: "/settings.json",
      log: () => {},
      exists: (path) => { checked.push(path); return path !== SLATE_WALLPAPER_COMMAND; },
    });
    assert.equal(paintMissing.isAvailable, false);
    assert.deepEqual(checked, [SLATE_WALLPAPER_TONE_SCRIPT, SLATE_WALLPAPER_COMMAND]);
  });

  it("logs an unusable tone plan and a failed tone helper without throwing", async () => {
    const logs: string[] = [];
    const invalid = createBoxWallpaperCommands({
      settingsPath: "/settings.json",
      log: (message) => logs.push(message),
      runCommand: async () => ({ stdout: "bright soon" }),
    });
    assert.equal(await invalid.resolvePlan(), undefined);
    assert.deepEqual(logs, ["wallpaper: tone helper printed an unusable plan"]);

    const failed = createBoxWallpaperCommands({
      settingsPath: "/settings.json",
      log: (message) => logs.push(message),
      runCommand: async () => { throw new Error("helper failed"); },
    });
    assert.equal(await failed.resolvePlan(), undefined);
    assert.equal(logs.at(-1), "wallpaper: tone helper failed (helper failed)");
  });

  it("continues painting other displays when one command fails", async () => {
    const logs: string[] = [];
    const invocations: Array<{ file: string; args: readonly string[]; timeout: number }> = [];
    const commands = createBoxWallpaperCommands({
      settingsPath: "/settings.json",
      log: (message) => logs.push(message),
      wallpaperCommandPath: "/bin/slate-wallpaper",
      readDisplays: async () => [
        { display: ":0", uid: 10, gid: 20 },
        { display: ":1", uid: 11, gid: 21 },
        { display: ":2", uid: 12, gid: 22 },
      ],
      runCommand: async (file, args, options) => {
        invocations.push({ file, args, timeout: options.timeout });
        if (args[1] === ":1") throw new Error("display unavailable");
        return { stdout: "" };
      },
    });
    await commands.paint();
    assert.deepEqual(invocations.map((call) => call.args), [["paint", ":0"], ["paint", ":1"], ["paint", ":2"]]);
    assert.equal(invocations.every((call) => call.timeout === COMMAND_TIMEOUT_MS), true);
    assert.deepEqual(logs, ["wallpaper: paint of :1 failed (display unavailable)"]);
  });
});
