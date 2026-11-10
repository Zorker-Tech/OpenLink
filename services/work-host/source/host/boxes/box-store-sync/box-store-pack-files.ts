/** Gzip pack writing and integrity-checked extraction. */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import type { WriteStream } from "node:fs";
import type { PackMember } from "./box-store-pack-index.ts";

export interface PackSource {
  readonly absPath: string;
  readonly sha: string;
  readonly size: number;
  readonly vmtime: number;
}

interface WrittenPackMember extends PackMember {}

class PackOutput {
  private nextOffset = 0;
  private writeFailure: unknown;
  private readonly members: WrittenPackMember[] = [];
  private readonly stream: WriteStream;

  constructor(path: string) {
    this.stream = createWriteStream(path);
    this.stream.on("error", error => { this.writeFailure ??= error; });
  }

  async append(source: PackSource, bytes: Buffer): Promise<void> {
    const compressed = gzipSync(bytes);
    await new Promise<void>((resolve, reject) => {
      this.stream.write(compressed, error => error == null ? resolve() : reject(error));
    });
    this.members.push({
      sha: source.sha,
      size: source.size,
      offset: this.nextOffset,
      clen: compressed.byteLength,
      vmtime: source.vmtime,
    });
    this.nextOffset += compressed.byteLength;
  }

  stop(): void {
    this.stream.destroy();
  }

  async finish(path: string): Promise<{ members: PackMember[]; fileBytes: number }> {
    await new Promise<void>(resolve => this.stream.end(resolve));
    if (this.writeFailure != null) throw this.writeFailure;
    return { members: this.members, fileBytes: (await stat(path)).size };
  }
}

async function stableSource(source: PackSource): Promise<Buffer | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(source.absPath);
  } catch {
    return null;
  }
  if (bytes.byteLength !== source.size) return null;
  return createHash("sha256").update(bytes).digest("hex") === source.sha ? bytes : null;
}

export async function buildPackFile(
  destPath: string,
  sources: readonly PackSource[],
  shouldAbort?: () => boolean,
): Promise<{ members: PackMember[]; fileBytes: number; skipped: number } | null> {
  const output = new PackOutput(destPath);
  let skipped = 0;
  try {
    for (const source of sources) {
      if (shouldAbort?.() === true) {
        output.stop();
        return null;
      }
      const bytes = await stableSource(source);
      if (bytes === null) {
        skipped += 1;
        continue;
      }
      await output.append(source, bytes);
    }
    const complete = await output.finish(destPath);
    return { ...complete, skipped };
  } catch (error) {
    output.stop();
    throw error;
  }
}

async function extractOne(args: {
  handle: Awaited<ReturnType<typeof open>>;
  member: PackMember;
  admitBytes?: (bytes: number) => Promise<() => void>;
  onBlob(member: PackMember, bytes: Uint8Array): Promise<void>;
}): Promise<boolean> {
  const release = args.admitBytes === undefined ? undefined : await args.admitBytes(args.member.clen + args.member.size);
  try {
    const compressed = Buffer.alloc(args.member.clen);
    const read = await args.handle.read(compressed, 0, args.member.clen, args.member.offset);
    if (read.bytesRead !== args.member.clen) return false;

    let content: Buffer;
    try {
      content = gunzipSync(compressed, { maxOutputLength: Math.max(args.member.size, 1) });
    } catch {
      return false;
    }
    if (content.byteLength !== args.member.size) return false;
    if (createHash("sha256").update(content).digest("hex") !== args.member.sha) return false;

    await args.onBlob(args.member, new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
    return true;
  } finally {
    release?.();
  }
}

export async function extractPackMembers(args: {
  packPath: string;
  members: readonly PackMember[];
  concurrency?: number;
  wants(member: PackMember): boolean;
  admitBytes?(bytes: number): Promise<() => void>;
  onBlob(member: PackMember, bytes: Uint8Array): Promise<void>;
}): Promise<{ extracted: number; mismatched: number }> {
  const handle = await open(args.packPath, "r");
  const workerCount = Math.max(1, args.concurrency ?? 1);
  let extracted = 0;
  let mismatched = 0;
  let cursor = 0;

  try {
    const worker = async (): Promise<void> => {
      while (cursor < args.members.length) {
        const member = args.members[cursor++];
        if (member === undefined || !args.wants(member)) continue;
        if (await extractOne({ handle, member, ...(args.admitBytes === undefined ? {} : { admitBytes: args.admitBytes }), onBlob: args.onBlob })) extracted += 1;
        else mismatched += 1;
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(workerCount, args.members.length) }, worker));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } finally {
    await handle.close();
  }
  return { extracted, mismatched };
}
