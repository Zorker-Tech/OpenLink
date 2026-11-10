/**
 * Writing a cloud agent's transcript into its box.
 *
 * A cloud agent's full transcript is longer than the result a caller gets, so it is dumped into the box as a file the
 * agent's own tools can read: a transcript with no lines is not written at all, and the completion line says where the
 * file is, how big it is and how to read the end of it.
 */

/** Where a cloud agent's transcript is dumped: one file per cloud agent, one JSON message per line. */
export function cloudAgentTranscriptDumpPath(agentId: string): string {
  return `cloud-agent-transcripts/${agentId}.jsonl`;
}

/** What a cloud agent answers with when its transcript is asked for. */
export interface CloudAgentDumpApi {
  getTranscriptDump(args: { agentId: string }): Promise<{ status: string; lineCount: number; jsonl: string } | null>;
}

/** What dumping a transcript needs: the agent's API, the box's file writer, and which agent. */
interface TranscriptDumpDeps {
  readonly api: CloudAgentDumpApi;
  readonly writeBoxFile: (path: string, data: Uint8Array) => Promise<unknown>;
  readonly agentId: string;
}

/** A transcript's JSON lines as the bytes the box file is written with. */
function transcriptBytes(jsonl: string): Uint8Array {
  return new TextEncoder().encode(jsonl);
}

/** The transcript dumped into the agent's box, or nothing when there is no transcript to dump. */
export async function dumpCloudAgentTranscript(
  deps: TranscriptDumpDeps,
): Promise<{ status: string; lineCount: number; file?: { path: string; sizeBytes: number } } | null> {
  const transcript = await deps.api.getTranscriptDump({ agentId: deps.agentId });
  if (transcript == null) return null;
  // A transcript with nothing in it is not a file worth writing.
  if (transcript.lineCount === 0) return { status: transcript.status, lineCount: 0 };
  const targetPath = cloudAgentTranscriptDumpPath(deps.agentId);
  const bytes = transcriptBytes(transcript.jsonl);
  await deps.writeBoxFile(targetPath, bytes);
  return { status: transcript.status, lineCount: transcript.lineCount, file: { path: targetPath, sizeBytes: bytes.byteLength } };
}

/** The line a caller reads after the transcript was dumped: where it is, how big, and how to read its end. */
export function formatCloudAgentDumpCompletionLine(file: { path: string; sizeBytes: number }, lineCount: number): string {
  const where = `${file.path} (${file.sizeBytes} bytes, ${lineCount} message lines)`;
  const tailCommand = `tail -n 1 ${file.path}`;
  return `Full transcript dumped to ${where}. Read it with your shell tools; \`${tailCommand}\` gives the final assistant report.`;
}

/** A watch result, with where its transcript went appended — and left exactly as it was when it could not be dumped. */
export async function augmentWatchResultWithTranscriptDump<Result extends { text: string }>(
  deps: TranscriptDumpDeps & { readonly result: Result },
): Promise<Result> {
  try {
    const dumped = await dumpCloudAgentTranscript(deps);
    if (dumped?.file != null) return { ...deps.result, text: `${deps.result.text}\n\n${formatCloudAgentDumpCompletionLine(dumped.file, dumped.lineCount)}` };
  } catch {}
  return deps.result;
}
