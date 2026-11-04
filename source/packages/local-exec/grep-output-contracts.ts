export interface ParsedGrepFilesOutput {
  readonly files: string[];
  readonly totalFiles: number;
  readonly clientTruncated: boolean;
  readonly ripgrepTruncated: boolean;
}

export interface ParsedGrepCount {
  readonly file: string;
  readonly count: number;
}

export interface ParsedGrepCountOutput {
  readonly counts: ParsedGrepCount[];
  readonly totalFiles: number;
  readonly totalMatches: number;
  readonly clientTruncated: boolean;
  readonly ripgrepTruncated: boolean;
}

export interface ParsedGrepContentMatch {
  readonly lineNumber: number;
  readonly content: string;
  readonly isContextLine: boolean;
}

export interface ParsedGrepContentFile {
  readonly file: string;
  readonly matches: ParsedGrepContentMatch[];
}

export interface ParsedGrepContentOutput {
  readonly byFile: Map<string, ParsedGrepContentFile>;
  readonly totalLines: number;
  readonly totalMatchedLines: number;
  readonly totalFiles: number;
  readonly clientTruncated: boolean;
  readonly ripgrepTruncated: boolean;
}
