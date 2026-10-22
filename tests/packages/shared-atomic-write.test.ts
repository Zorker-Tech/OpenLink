import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { writeFileAtomic } from "../../source/shared/node/atomic-write.ts";

/** A directory of its own for one case, removed however the case ends. */
async function inTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slate-atomic-write-"));
  try {
    await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** What a failed or finished write left of its staging file, if anything. */
const stagingFiles = (directory: string): string[] => fs.readdirSync(directory).filter((name) => name.endsWith(".part"));

describe("writing a file atomically", () => {
  it("writes the whole file and makes the directories on the way", async () => {
    await inTemporaryDirectory(async (directory) => {
      const target = path.join(directory, "a", "b", "settings.json");
      await writeFileAtomic(target, "first");
      assert.equal(fs.readFileSync(target, "utf8"), "first");
      assert.deepEqual(fs.readdirSync(path.dirname(target)), ["settings.json"], "nothing of the writing is left beside the file");
      await writeFileAtomic(target, "second");
      assert.equal(fs.readFileSync(target, "utf8"), "second", "an existing file is replaced whole");
    });
  });

  it("writes bytes as bytes and an empty text as an empty file", async () => {
    await inTemporaryDirectory(async (directory) => {
      const binary = path.join(directory, "image.bin");
      await writeFileAtomic(binary, new Uint8Array([0, 255, 1, 254]));
      assert.deepEqual(fs.readFileSync(binary), Buffer.from([0, 255, 1, 254]));
      const empty = path.join(directory, "empty.txt");
      await writeFileAtomic(empty, "");
      assert.equal(fs.readFileSync(empty, "utf8"), "");
    });
  });

  it("gives the file the mode it was asked for", async () => {
    await inTemporaryDirectory(async (directory) => {
      const target = path.join(directory, "secret.json");
      await writeFileAtomic(target, "s", { mode: 0o600 });
      assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    });
  });

  it("leaves the old file and no staging file when the write fails", async () => {
    await inTemporaryDirectory(async (directory) => {
      const target = path.join(directory, "settings.json");
      fs.writeFileSync(target, "old");
      await assert.rejects(() => writeFileAtomic(target, {} as unknown as Uint8Array));
      assert.equal(fs.readFileSync(target, "utf8"), "old", "a write that fails does not touch the file that was there");
      assert.deepEqual(stagingFiles(directory), [], "and it takes its staging file with it");
    });
  });

  it("takes the staging file with it when the rename fails, and names it after the target", async () => {
    await inTemporaryDirectory(async (directory) => {
      const target = path.join(directory, "settings.json");
      fs.mkdirSync(target);
      await assert.rejects(
        () => writeFileAtomic(target, "x"),
        (error: NodeJS.ErrnoException) => {
          assert.equal(error.code, "EISDIR");
          // The staging file is the target's name, in the target's own directory, with a random hex part.
          assert.match(String(error.message), /\.settings\.json\.[0-9a-f]{16}\.part/);
          return true;
        },
      );
      assert.deepEqual(stagingFiles(directory), []);
      assert.equal(fs.statSync(target).isDirectory(), true, "a failed rename leaves the target as it was");
    });
  });
});
