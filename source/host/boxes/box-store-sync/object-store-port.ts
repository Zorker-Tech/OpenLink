/** The failure record shared by writes that lost a concurrent update race. */
interface WriteConflictRecord {
  readonly key: string;
  readonly conflictRelPath: string | null;
  readonly baseEtag: string | null;
  readonly baselineSource: string | null;
}

interface WriteConflictInput {
  readonly key: string;
  readonly conflictRelPath?: string | null;
  readonly baseEtag?: string | null;
  readonly baselineSource?: string | null;
}

function conflictRecordFrom(input: WriteConflictInput): WriteConflictRecord {
  return {
    key: input.key,
    conflictRelPath: input.conflictRelPath ?? null,
    baseEtag: input.baseEtag ?? null,
    baselineSource: input.baselineSource ?? null,
  };
}

function conflictMessage(record: WriteConflictRecord): string {
  if (record.conflictRelPath == null) {
    return `canonical write for ${record.key} lost a concurrent-write race`;
  }
  return `agent-store write for ${record.key} lost a concurrent-write race; content preserved at ${record.conflictRelPath}`;
}

export class BoxStoreCanonicalWriteConflictError extends Error {
  readonly key: string;
  readonly conflictRelPath: string | null;
  readonly baseEtag: string | null;
  readonly baselineSource: string | null;

  constructor(input: WriteConflictInput) {
    const record = conflictRecordFrom(input);
    super(conflictMessage(record));
    this.name = "BoxStoreCanonicalWriteConflictError";
    this.key = record.key;
    this.conflictRelPath = record.conflictRelPath;
    this.baseEtag = record.baseEtag;
    this.baselineSource = record.baselineSource;
  }
}
