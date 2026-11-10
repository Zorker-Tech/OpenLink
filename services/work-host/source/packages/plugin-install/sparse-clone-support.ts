type SparseSupportProbeOptions = {
  readonly isDisabled: () => boolean
  readonly readVersion: () => Promise<string>
}

function meetsSparseMinimum(versionText: string): boolean {
  const components = /git version (\d+)\.(\d+)/.exec(versionText)
  if (components === null) return false

  const major = Number(components[1])
  const minor = Number(components[2])
  return major > 2 || (major === 2 && minor >= 26)
}

/** Build a process-local capability check with one shared read, including a cached negative result. */
export function createSparseCloneSupportProbe({ isDisabled, readVersion }: SparseSupportProbeOptions): () => Promise<boolean> {
  let result: Promise<boolean> | undefined

  return () => {
    if (isDisabled()) return Promise.resolve(false)
    result ??= Promise.resolve()
      .then(readVersion)
      .then(meetsSparseMinimum)
      .catch(() => false)
    return result
  }
}
