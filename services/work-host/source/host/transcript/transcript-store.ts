/** The host's in-memory list of transcript entries. */
import type { TranscriptEntry } from "./transcript-hub.ts"

class TranscriptBuffer {
  private entries: TranscriptEntry[] | undefined

  read(): TranscriptEntry[] {
    return this.entries ?? []
  }

  replace(entries: readonly TranscriptEntry[]): void {
    this.entries = [...entries]
  }

  append(entry: TranscriptEntry): void {
    this.entries = [...this.read(), entry]
  }

  update(id: string, transform: (entry: TranscriptEntry) => TranscriptEntry): TranscriptEntry | null {
    let replacement: TranscriptEntry | null = null
    const next = this.read().map(entry => {
      if (entry.id !== id) return entry
      const changed = transform(entry)
      replacement = changed
      return changed
    })
    if (replacement == null) return null
    this.entries = next
    return replacement
  }

  remove(id: string): boolean {
    const current = this.read()
    const remaining = current.filter(entry => entry.id !== id)
    if (remaining.length === current.length) return false
    this.entries = remaining
    return true
  }

  clear(): void {
    this.entries = []
  }
}

const transcript = new TranscriptBuffer()

export function getTranscript(): TranscriptEntry[] {
  return transcript.read()
}

export function setTranscript(entries: readonly TranscriptEntry[]): void {
  transcript.replace(entries)
}

export function appendEntry(entry: TranscriptEntry): void {
  transcript.append(entry)
}

export function updateEntry(
  id: string,
  update: (entry: TranscriptEntry) => TranscriptEntry,
): TranscriptEntry | null {
  return transcript.update(id, update)
}

export function removeEntry(id: string): boolean {
  return transcript.remove(id)
}

export function clearTranscript(): void {
  transcript.clear()
}
