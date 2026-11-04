import type { RemoteCommitRecord } from "./git-ref-resolution-contracts.ts"

const SHORT_COMMIT_PREFIX = /^[0-9a-f]{7,39}$/i
const FULL_COMMIT_ID = /^[0-9a-f]{40}$/i

export function isFullCommitId(ref: string): boolean {
  return FULL_COMMIT_ID.test(ref)
}

export function isCommitPrefix(ref: string): boolean {
  return SHORT_COMMIT_PREFIX.test(ref)
}

export function parseRemoteCommitRecords(stdout: string | undefined): RemoteCommitRecord[] {
  if (stdout === undefined || stdout.length === 0) return []

  const records: RemoteCommitRecord[] = []
  for (const row of stdout.split(/\r?\n/)) {
    const [sha, refName] = row.split("\t")
    if (sha && refName && FULL_COMMIT_ID.test(sha)) records.push({ sha, refName })
  }
  return records
}

export function selectResolvedCommit(stdout: string | undefined): string | undefined {
  const records = parseRemoteCommitRecords(stdout)
  const peeledTag = records.find((record) => record.refName.endsWith("^{}"))
  return (peeledTag ?? records[0])?.sha.toLowerCase()
}
