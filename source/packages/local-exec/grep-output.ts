import { clampInt32 } from "./int32.ts";
import type { ParsedGrepCount, ParsedGrepCountOutput, ParsedGrepFilesOutput } from "./grep-output-contracts.ts";
import { readCountRow, splitGrepLines } from "./grep-output-records.ts";

export type {
  ParsedGrepCount,
  ParsedGrepCountOutput,
  ParsedGrepContentFile,
  ParsedGrepContentMatch,
  ParsedGrepContentOutput,
  ParsedGrepFilesOutput,
} from "./grep-output-contracts.ts";
export { splitGrepLines } from "./grep-output-records.ts";
export { parseGrepContentOutput } from "./grep-output-content.ts";

export function parseGrepFilesOutput(stdout: string, clientLimitLines: number, ripgrepHardCuttoffLines: number): ParsedGrepFilesOutput {
  const trimmed = stdout.trim();
  const files = trimmed.length === 0 ? [] : splitGrepLines(trimmed);
  return {
    files: files.slice(0, clientLimitLines),
    totalFiles: clampInt32(files.length),
    clientTruncated: files.length > clientLimitLines,
    ripgrepTruncated: files.length >= ripgrepHardCuttoffLines,
  };
}

export function parseGrepCountOutput(stdout: string, clientLimitLines: number, ripgrepHardCuttoffLines: number): ParsedGrepCountOutput {
  const trimmed = stdout.trim();
  const rows = trimmed.length === 0 ? [] : splitGrepLines(trimmed);
  const counts: ParsedGrepCount[] = rows.flatMap((row) => {
    if (row.length === 0) return [];
    const parsed = readCountRow(row);
    return parsed === undefined ? [] : [parsed];
  });
  const matches = counts.reduce((total, row) => total + row.count, 0);
  return {
    counts: counts.slice(0, clientLimitLines),
    totalFiles: clampInt32(counts.length),
    totalMatches: clampInt32(matches),
    clientTruncated: counts.length > clientLimitLines,
    ripgrepTruncated: counts.length >= ripgrepHardCuttoffLines,
  };
}
