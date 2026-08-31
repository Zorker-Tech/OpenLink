#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { configureBundledPodmanRuntime } from './lib/bundled-podman-runtime.mjs'
import { ensureWindowsHyperVGroupMembership, inspectWindowsHyperVHost } from './lib/windows-hyperv.mjs'
import { run, runCapture } from './lib/podman-builder.mjs'
import { assertWindowsRuntimeDirectoryHyperVAccess, prepareWindowsRuntimeDirectory } from './lib/windows-security.mjs'

if (process.platform !== 'win32') throw new Error('Windows native host preparation can run on Windows only')
const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const runtime = await configureBundledPodmanRuntime(root)
const podman = runtime.podman
const before = await inspectWindowsHyperVHost(podman)
if (!before.Elevated) {
  throw new Error('This one-time command must run in an elevated PowerShell terminal. It creates Podman Hyper-V VSock registry entries and adds the current account to Hyper-V Administrators.')
}
const runtimeRoot = resolve(root, '.openlink-runtime')
await mkdir(runtimeRoot, { recursive: true })
await prepareWindowsRuntimeDirectory(runtimeRoot)
await assertWindowsRuntimeDirectoryHyperVAccess(runtimeRoot)
// Resolve the built-in group by its stable SID. This works on localized
// Windows editions and avoids Podman's name-based membership edge cases.
await ensureWindowsHyperVGroupMembership()
if (!before.vsockReady) {
  await run(podman, ['system', 'hyperv-prep'], { cwd: root, timeout: 120_000 })
}
const after = await inspectWindowsHyperVHost(podman, { runner: runCapture })
process.stdout.write(`${JSON.stringify(after, null, 2)}\n`)
// Group changes never enter the token of the process that made them. Exact
// membership was verified through the local group API above; only VSock can
// be required from this still-stale elevated token.
if (!after.vsockReady) throw new Error('Hyper-V preparation did not create the required persistent VSock registry entries')
process.stdout.write('Windows native host preparation is complete. Sign out and sign back in before starting OpenLink from a non-elevated terminal.\n')
