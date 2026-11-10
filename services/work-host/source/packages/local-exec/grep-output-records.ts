import type { ParsedGrepCount } from "./grep-output-contracts.ts";

export interface ParsedGrepLine {
  readonly file: string;
  readonly lineNumber: number;
  readonly content: string;
  readonly isContextLine: boolean;
}

export function splitGrepLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export function readCountRow(line: string): ParsedGrepCount | undefined {
  const splitAt = line.lastIndexOf(":");
  if (splitAt <= 0) return undefined;
  const count = Number.parseInt(line.slice(splitAt + 1).trim(), 10);
  return Number.isFinite(count) ? { file: line.slice(0, splitAt), count } : undefined;
}

export function readMatchRow(line: string): ParsedGrepLine | undefined {
  if (line === "--") return undefined;
  const fileBoundary = line.indexOf("\0");
  if (fileBoundary < 0) return undefined;
  const match = /^(\d+)([:-])(.*)$/.exec(line.slice(fileBoundary + 1));
  if (match === null) return undefined;
  const lineNumber = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(lineNumber)) return undefined;
  return {
    file: line.slice(0, fileBoundary),
    lineNumber,
    content: match[3] ?? "",
    isContextLine: match[2] === "-",
  };
}
