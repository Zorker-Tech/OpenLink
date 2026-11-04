import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  fileIdentity,
  isMissingFile,
  parseDeferredStep,
  parsePendingCheckpoint,
  TranscriptJournalCorruptionError,
  writeAll,
  type DeferredTranscriptStep,
  type PendingTranscriptCheckpoint,
  type TranscriptCheckpoint,
} from "./transcript-journal-codec.ts";
import type { TranscriptFileState, TranscriptOccurrence } from "./transcript-mirror-contracts.ts";

function requireSafeConversationId(id: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..") return id;
  throw new TranscriptJournalCorruptionError("unsafe conversation id");
}

export class TranscriptMirrorFiles {
  constructor(readonly transcriptsDir: string) {}

  jsonlPathFor(id: string): string {
    const safeId = requireSafeConversationId(id);
    return join(this.transcriptsDir, safeId, safeId + ".jsonl");
  }

  pendingPathFor(id: string): string {
    const safeId = requireSafeConversationId(id);
    return join(this.transcriptsDir, safeId, safeId + ".journal-pending.json");
  }

  cursorPathFor(id: string): string {
    const safeId = requireSafeConversationId(id);
    return join(this.transcriptsDir, safeId, safeId + ".journal-cursor.json");
  }

  modePathFor(id: string): string {
    const safeId = requireSafeConversationId(id);
    return join(this.transcriptsDir, safeId, safeId + ".journal-mode");
  }

  async ownsConversation(id: string): Promise<boolean> {
    try {
      await stat(this.modePathFor(id));
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  async claimConversation(id: string): Promise<void> {
    if (await this.ownsConversation(id)) return;
    await this.installAtomic(this.modePathFor(id), Buffer.from("1\n"));
  }

  async readPending(id: string): Promise<PendingTranscriptCheckpoint | null> {
    try {
      return parsePendingCheckpoint(await readFile(this.pendingPathFor(id), "utf8"));
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async removePending(id: string): Promise<void> {
    const path = this.pendingPathFor(id);
    try {
      await unlink(path);
      await this.syncParent(path);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  async readDeferred(id: string): Promise<DeferredTranscriptStep | undefined> {
    try {
      return parseDeferredStep(JSON.parse(await readFile(this.cursorPathFor(id), "utf8")));
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async writeDeferred(id: string, cursor?: DeferredTranscriptStep): Promise<void> {
    const path = this.cursorPathFor(id);
    if (cursor == null) {
      try {
        await unlink(path);
        await this.syncParent(path);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      return;
    }
    await this.installAtomic(path, Buffer.from(JSON.stringify(cursor)));
  }

  async initialize(
    id: string,
    checkpoint: TranscriptCheckpoint,
    buildInitial: () => Promise<readonly TranscriptOccurrence[]>,
  ): Promise<TranscriptFileState> {
    const path = this.jsonlPathFor(id);
    await mkdir(dirname(path), { recursive: true });
    let rebuild = false;
    try {
      const info = await stat(path);
      if (info.size === 0) {
        rebuild = checkpoint.turns.length > 0;
      } else {
        const handle = await open(path, "r");
        try {
          const lastByte = Buffer.alloc(1);
          const read = await handle.read(lastByte, 0, 1, info.size - 1);
          rebuild = read.bytesRead !== 1 || lastByte[0] !== 10;
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      rebuild = true;
    }

    if (rebuild) {
      const occurrences = await buildInitial();
      const jsonl = occurrences.map((occurrence) => occurrence.line + "\n").join("");
      await this.installAtomic(path, Buffer.from(jsonl));
    }
    const identity = fileIdentity(await stat(path));
    return { bytes: identity.size, device: identity.device, inode: identity.inode };
  }

  async currentIdentity(id: string) {
    return fileIdentity(await stat(this.jsonlPathFor(id)));
  }

  async appendPending(id: string, pending: PendingTranscriptCheckpoint): Promise<TranscriptFileState> {
    const path = this.jsonlPathFor(id);
    const current = fileIdentity(await stat(path));
    if (current.device !== pending.fileDevice || current.inode !== pending.fileInode || current.size < pending.appendOffset) {
      throw new TranscriptJournalCorruptionError("canonical transcript changed before WAL commit");
    }

    const bytes = Buffer.from(pending.lines.map((line) => line + "\n").join(""));
    const existingTailSize = current.size - pending.appendOffset;
    if (existingTailSize > bytes.length) {
      throw new TranscriptJournalCorruptionError("canonical transcript has data beyond the pending WAL");
    }

    const handle = await open(path, "r+");
    try {
      if (existingTailSize > 0) {
        const tail = Buffer.alloc(existingTailSize);
        await handle.read(tail, 0, tail.length, pending.appendOffset);
        if (!bytes.subarray(0, existingTailSize).equals(tail)) {
          throw new TranscriptJournalCorruptionError("canonical transcript tail conflicts with the pending WAL");
        }
      }
      if (existingTailSize < bytes.length) {
        await handle.truncate(pending.appendOffset);
        await writeAll(handle, bytes, pending.appendOffset);
        await handle.sync();
      }
      const updated = fileIdentity(await handle.stat());
      return { bytes: pending.appendOffset + bytes.length, device: updated.device, inode: updated.inode };
    } finally {
      await handle.close();
    }
  }

  async installAtomic(path: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), ".transcript." + randomUUID() + ".part");
    let handle;
    try {
      handle = await open(temporary, "wx");
      await writeAll(handle, bytes, 0);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      await this.syncParent(path);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async syncParent(path: string): Promise<void> {
    const handle = await open(dirname(path), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
