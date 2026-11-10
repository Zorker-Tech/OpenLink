import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const OUTPUT_DIRECTORY = "agent-tools";
const OUTPUT_FILE_LIMIT_BYTES = 50 * 1024 * 1024;

export interface ShellOutputFileDetails {
  readonly filePath: string;
  readonly byteCount: number;
  readonly lineCount: number;
}

/** Accumulate the combined stdout/stderr stream until it belongs in a project file. */
export class ShellCoreOutputCapture {
  private buffer = "";
  private byteCount = 0;
  private lineCount = 0;
  private filePath: string | undefined;
  private file: WriteStream | undefined;

  constructor(private readonly projectDir: string, private readonly thresholdBytes: number) {}

  async append(text: string, chunkBytes: number): Promise<void> {
    this.byteCount += chunkBytes;
    this.lineCount += text.split("\n").length - 1;
    if (this.byteCount > OUTPUT_FILE_LIMIT_BYTES) return;

    if (this.file !== undefined) {
      this.file.write(text);
      return;
    }

    this.buffer += text;
    if (this.byteCount <= this.thresholdBytes) return;

    const directory = join(this.projectDir, OUTPUT_DIRECTORY);
    this.filePath = join(directory, `${randomUUID()}.txt`);
    await mkdir(dirname(this.filePath), { recursive: true });
    this.file = createWriteStream(this.filePath);
    this.file.write(this.buffer);
    this.buffer = "";
  }

  async finish(): Promise<ShellOutputFileDetails | undefined> {
    if (this.file === undefined || this.filePath === undefined) return undefined;
    await new Promise<void>((done) => this.file?.end(done));
    return { filePath: this.filePath, byteCount: this.byteCount, lineCount: this.lineCount };
  }
}
