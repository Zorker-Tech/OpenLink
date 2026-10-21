/**
 * The diff a file edit produced, in the form git would print it.
 *
 * A written file has to be reported as a change rather than as a new file's contents, and the report has
 * to look like what the user expects from git: a header naming both sides, hunks with their line ranges,
 * and the counts of added and removed lines. An added file and a deleted one are named as `/dev/null` on
 * the side that does not exist, which is how git names it and what the review tooling reads.
 *
 * The text is normalized to end in a newline before diffing, so a file that lacks the trailing newline
 * does not produce a spurious final change.
 */

import { structuredPatch } from "diff";

export interface DiffWorkerInput {
  readonly original: string;
  readonly new: string;
  readonly filePath?: string;
  readonly fileChangeType?: string;
}

export interface DiffWorkerResult {
  readonly diffString: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

/** The name git gives a side of the diff that does not exist. */
const ABSENT = "/dev/null";

/** How many lines of context a hunk carries either side: git's own default. */
const CONTEXT_LINES = 3;

/** A side of the diff as git writes it, unless that side is the one that does not exist. */
function sideOf(path: string, prefix: string): string {
  return path === ABSENT ? path : `${prefix}/${path}`;
}

/** The text as git compares it: a file that lacks a trailing newline would otherwise show a change it did not have. */
function asLineTerminated(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/** A hunk's range as git writes it: `start,count`, or the bare start for a single line and `start,0` for none. */
function rangeOf(start: number, lineCount: number): string {
  if (lineCount === 0) return `${start},0`;
  if (lineCount === 1) return `${start}`;
  return `${start},${lineCount}`;
}

/** The name the report gives the file: the one it was told, or a plain one nothing else may claim. */
function reportedPath(filePath: string | undefined): string {
  const trimmed = filePath?.trim();
  return trimmed != null && trimmed.length > 0 ? trimmed : "file";
}

/** How many of a hunk's lines begin with this marker — the added ones, or the removed ones. */
function linesMarked(hunks: readonly { readonly lines: readonly string[] }[], marker: string): number {
  let count = 0;
  for (const hunk of hunks) for (const line of hunk.lines) if (line.startsWith(marker)) count += 1;
  return count;
}

/** The diff a change to a file produced, in the form git would print it, and what it added and removed. */
export function calculateDiff(params: DiffWorkerInput): DiffWorkerResult {
  const { hunks } = structuredPatch("a", "b", asLineTerminated(params.original), asLineTerminated(params.new), "", "", { context: CONTEXT_LINES });
  const path = reportedPath(params.filePath);
  const changeType = params.fileChangeType ?? "modified";
  const oldPath = changeType === "added" ? ABSENT : path;
  const newPath = changeType === "deleted" ? ABSENT : path;
  const diffString =
    hunks.length === 0
      ? ""
      : [
          `--- ${sideOf(oldPath, "a")}`,
          `+++ ${sideOf(newPath, "b")}`,
          ...hunks.flatMap((hunk) => [`@@ -${rangeOf(hunk.oldStart, hunk.oldLines)} +${rangeOf(hunk.newStart, hunk.newLines)} @@`, ...hunk.lines]),
        ].join("\n");
  return { diffString, linesAdded: linesMarked(hunks, "+"), linesRemoved: linesMarked(hunks, "-") };
}

export default calculateDiff;
