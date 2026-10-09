/**
 * Writing a cloud agent's transcript into its box.
 *
 * A cloud agent's full transcript is longer than the result a caller gets, so it is dumped into the box as a file the
 * agent's own tools can read: a transcript with no lines is not written at all, and the completion line says where the
 * file is, how big it is and how to read the end of it.
 */

/** Where a cloud agent's transcript is dumped: one file per cloud agent, one JSON message per line. */
export function cloudAgentTranscriptDumpPath(bcId: string): string {
  return `cloud-agent-transcripts/${bcId}.jsonl`;
}

export interface CloudAgentDumpApi {
  getTranscriptDump(args: { bcId: string }): Promise<{ status: string; lineCount: number; jsonl: string } | null>;
}

export async function dumpCloudAgentTranscript(args: {
  readonly api: CloudAgentDumpApi;
  readonly writeBoxFile: (path: string, data: Uint8Array) => Promise<unknown>;
  readonly bcId: string;
}): Promise<{ status: string; lineCount: number; file?: { path: string; sizeBytes: number } } | null> {
  const dump = await args.api.getTranscriptDump({ bcId: args.bcId });
  if (dump == null) return null;
  // A transcript with nothing in it is not a file worth writing.
  if (dump.lineCount === 0) return { status: dump.status, lineCount: 0 };
  const path = cloudAgentTranscriptDumpPath(args.bcId);
  const data = new TextEncoder().encode(dump.jsonl);
  await args.writeBoxFile(path, data);
  return { status: dump.status, lineCount: dump.lineCount, file: { path, sizeBytes: data.byteLength } };
}

export function formatCloudAgentDumpCompletionLine(file: { path: string; sizeBytes: number }, lineCount: number): string {
  return `Full transcript dumped to ${file.path} (${file.sizeBytes} bytes, ${lineCount} message lines). Read it with your shell tools; \`tail -n 1 ${file.path}\` gives the final assistant report.`;
}

/** A watch result, with where its transcript went appended — and left exactly as it was when it could not be dumped. */
export async function augmentWatchResultWithTranscriptDump<Result extends { text: string }>(args: {
  readonly api: CloudAgentDumpApi;
  readonly writeBoxFile: (path: string, data: Uint8Array) => Promise<unknown>;
  readonly bcId: string;
  readonly result: Result;
}): Promise<Result> {
  try {
    const outcome = await dumpCloudAgentTranscript(args);
    if (outcome?.file != null) return { ...args.result, text: `${args.result.text}\n\n${formatCloudAgentDumpCompletionLine(outcome.file, outcome.lineCount)}` };
  } catch {}
  return args.result;
}
