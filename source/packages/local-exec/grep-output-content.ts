import type { Context } from "../context/context.ts";
import { createSpan } from "../context/telemetry.ts";
import { clampInt32 } from "./int32.ts";
import type { ParsedGrepContentFile, ParsedGrepContentOutput } from "./grep-output-contracts.ts";
import { readMatchRow, splitGrepLines } from "./grep-output-records.ts";

export function parseGrepContentOutput(
  stdout: string,
  clientLimitLines: number,
  ripgrepHardCuttoffLines: number,
  ctx: Context,
): ParsedGrepContentOutput {
  using span = createSpan(ctx.withName("parseContentOutput"));
  const lines = stdout.trim() === "" ? [] : splitGrepLines(stdout);
  if (lines.at(-1) === "") lines.pop();

  const byFile = new Map<string, ParsedGrepContentFile>();
  const files = new Set<string>();
  let matchedLines = 0;
  let exposedLines = 0;

  for (const line of lines) {
    const match = readMatchRow(line);
    if (match === undefined) continue;
    if (!match.isContextLine) matchedLines += 1;
    files.add(match.file);
    if (exposedLines >= clientLimitLines) continue;

    let bucket = byFile.get(match.file);
    if (bucket === undefined) {
      bucket = { file: match.file, matches: [] };
      byFile.set(match.file, bucket);
    }
    bucket.matches.push({ lineNumber: match.lineNumber, content: match.content, isContextLine: match.isContextLine });
    exposedLines += 1;
  }

  return {
    byFile,
    totalLines: clampInt32(lines.length),
    totalMatchedLines: clampInt32(matchedLines),
    totalFiles: clampInt32(files.size),
    clientTruncated: exposedLines >= clientLimitLines,
    ripgrepTruncated: lines.length >= ripgrepHardCuttoffLines,
  };
}
