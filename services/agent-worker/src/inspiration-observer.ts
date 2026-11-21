import { opendir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'

const SKIP_DIRECTORIES = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', 'logs', 'log', 'tmp', 'temp', '__pycache__'])
const SKIP_FILE = /(?:^\.env(?:\.|$)|^id_(?:rsa|ed25519)|\.log(?:[.-]|$)|\.(?:tmp|swp|pid|sock|key|pem|p12|sqlite(?:3)?(?:-wal|-shm)?)$)/i
const MAX_ENTRIES = 6_000
const MAX_DEPTH = 12
const INTERVAL_MS = 5_000

export interface SandboxTraffic {
  receivedBytes: number
  sentBytes: number
}

export interface WorkspaceObservation {
  observedAt: number
  files: string[]
  traffic?: SandboxTraffic
}

interface Snapshot {
  files: Set<string>
  directories: Set<string>
  complete: Set<string>
}

async function scanWorkspace(root: string): Promise<Snapshot> {
  const snapshot: Snapshot = { files: new Set(), directories: new Set(['.']), complete: new Set() }
  const queue = [{ directory: '.', depth: 0 }]
  let visited = 0
  for (const { directory, depth } of queue) {
    if (visited >= MAX_ENTRIES) break
    const absolute = join(root, directory)
    try {
      if (await realpath(absolute) !== absolute) continue
      const handle = await opendir(absolute)
      for await (const entry of handle) {
        if (++visited > MAX_ENTRIES) break
        if (entry.name.startsWith('.') || /[\u0000-\u001f\u007f]/.test(entry.name)) continue
        const path = relative(root, join(absolute, entry.name))
        if (path.length > 300) continue
        if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name.toLowerCase()) && depth < MAX_DEPTH) {
          snapshot.directories.add(path)
          queue.push({ directory: path, depth: depth + 1 })
        } else if (entry.isFile() && !SKIP_FILE.test(entry.name)) {
          snapshot.files.add(path)
        }
      }
      if (visited <= MAX_ENTRIES) snapshot.complete.add(directory)
    } catch {
      // Directory disappeared, was replaced by a symlink, or is not readable.
    }
  }
  return snapshot
}

function previouslyCovered(file: string, snapshot: Snapshot): boolean {
  let directory = dirname(file)
  while (!snapshot.directories.has(directory) && directory !== '.') directory = dirname(directory)
  return snapshot.complete.has(directory)
}

export function parseSandboxTraffic(contents: string): SandboxTraffic {
  let receivedBytes = 0
  let sentBytes = 0
  for (const line of contents.split('\n')) {
    const [iface, values] = line.trim().split(':', 2)
    if (!values || iface === 'lo') continue
    const counters = values.trim().split(/\s+/)
    const received = Number(counters[0])
    const sent = Number(counters[8])
    if (!Number.isSafeInteger(received) || !Number.isSafeInteger(sent) || received < 0 || sent < 0) continue
    receivedBytes += received
    sentBytes += sent
  }
  return { receivedBytes, sentBytes }
}

async function readTraffic() {
  return readFile('/proc/net/dev', 'utf8').then(parseSandboxTraffic, () => null)
}

async function observe(root: string, observeNetwork: boolean) {
  const canonical = await realpath(root)
  let files = await scanWorkspace(canonical)
  let traffic = observeNetwork ? await readTraffic() : null
  parentPort?.postMessage('ready')
  const sample = async () => {
    const [nextFiles, nextTraffic] = await Promise.all([scanWorkspace(canonical), observeNetwork ? readTraffic() : null])
    const additions = [...nextFiles.files].filter((file) => !files.files.has(file) && previouslyCovered(file, files)).slice(0, 24)
    const receivedBytes = nextTraffic && traffic ? nextTraffic.receivedBytes - traffic.receivedBytes : 0
    const sentBytes = nextTraffic && traffic ? nextTraffic.sentBytes - traffic.sentBytes : 0
    // Liveness traffic and small background requests are not events.
    const network = receivedBytes >= 128 * 1024 || sentBytes >= 64 * 1024
    if (additions.length || network) {
      parentPort?.postMessage({
        observedAt: Date.now(), files: additions,
        ...(network ? { traffic: { receivedBytes: Math.max(0, receivedBytes), sentBytes: Math.max(0, sentBytes) } } : {}),
      } satisfies WorkspaceObservation)
    }
    files = nextFiles
    traffic = nextTraffic
    setTimeout(() => { void sample() }, INTERVAL_MS)
  }
  setTimeout(() => { void sample() }, INTERVAL_MS)
}

if (!isMainThread && typeof workerData?.workspaceRoot === 'string') await observe(workerData.workspaceRoot, workerData.observeNetwork === true)
