/**
 * The files a sandbox's policy is written to before a command runs.
 *
 * A sandbox is configured by a file the platform writes and the sandboxing mechanism reads, so the policy
 * has to reach the disk before the command starts and has to be readable by nobody else: the directory is
 * created private and each file is written private, since a policy says what the user's own machine allows.
 * Files are named after a random suffix rather than after the command, so two commands running at once
 * cannot collide, and old ones are swept when the directory is used — a policy that outlives the command it
 * was written for is only a file taking up space.
 */

import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const POLICY_FILE = {
  directoryName: "sandbox-policies",
  directoryMode: 0o700,
  fileMode: 0o600,
  environmentKey: "SLATE_SANDBOX_POLICY_DIR",
  maxAgeMs: 60 * 60 * 1_000,
  prefix: "sandbox-policy-",
  randomBytes: 8,
} as const

function resolvePolicyDirectory(): string {
  const override = process.env[POLICY_FILE.environmentKey]?.trim()
  const location = override || join(homedir(), ".slate", POLICY_FILE.directoryName)
  return resolve(location)
}

function pruneExpiredPolicies(directory: string): void {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return
  }

  const expirationTime = Date.now() - POLICY_FILE.maxAgeMs
  for (const name of names) {
    if (!name.startsWith(POLICY_FILE.prefix)) continue
    const candidate = join(directory, name)
    try {
      const metadata = statSync(candidate)
      if (metadata.isFile() && metadata.mtimeMs < expirationTime) unlinkSync(candidate)
    } catch {
      // A file that cannot be examined is left where it is rather than removed on a guess.
    }
  }
}

export function ensureSandboxPolicyDirectory(): string {
  const directory = resolvePolicyDirectory()
  mkdirSync(directory, { recursive: true, mode: POLICY_FILE.directoryMode })
  try {
    chmodSync(directory, POLICY_FILE.directoryMode)
  } catch {
    // A directory that already existed may not be ours to change; the files inside are still private.
  }
  pruneExpiredPolicies(directory)
  return directory
}

export function writeSandboxPolicyFile(policyJson: string): string {
  const directory = ensureSandboxPolicyDirectory()
  const suffix = randomBytes(POLICY_FILE.randomBytes).toString("hex")
  const filePath = join(directory, `${POLICY_FILE.prefix}${suffix}`)
  writeFileSync(filePath, policyJson, { encoding: "utf8", mode: POLICY_FILE.fileMode })
  return filePath
}
