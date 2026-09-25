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

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const SANDBOX_POLICY_DIR_NAME = "sandbox-policies"
const SANDBOX_POLICY_DIR_ENV = "SLATE_SANDBOX_POLICY_DIR"
const STALE_POLICY_MAX_AGE_MS = 60 * 60 * 1_000

function getSandboxPolicyDirectory(): string {
  const override = process.env[SANDBOX_POLICY_DIR_ENV]?.trim()
  if (override) {
    return path.resolve(override)
  }
  return path.resolve(path.join(os.homedir(), ".slate", SANDBOX_POLICY_DIR_NAME))
}

function pruneStaleSandboxPolicyFiles(dir: string): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of entries) {
    if (!name.startsWith("sandbox-policy-")) {
      continue
    }
    const fullPath = path.join(dir, name)
    try {
      const stat = fs.statSync(fullPath)
      if (!stat.isFile()) {
        continue
      }
      if (now - stat.mtimeMs > STALE_POLICY_MAX_AGE_MS) {
        fs.unlinkSync(fullPath)
      }
    } catch {
      // A file that cannot be examined is left where it is rather than removed on a guess.
    }
  }
}

export function ensureSandboxPolicyDirectory(): string {
  const dir = getSandboxPolicyDirectory()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // A directory that already existed may not be ours to change; the files inside are still private.
  }
  pruneStaleSandboxPolicyFiles(dir)
  return dir
}

export function writeSandboxPolicyFile(policyJson: string): string {
  const dir = ensureSandboxPolicyDirectory()
  const suffix = crypto.randomBytes(8).toString("hex")
  const filePath = path.join(dir, `sandbox-policy-${suffix}`)
  fs.writeFileSync(filePath, policyJson, { encoding: "utf-8", mode: 0o600 })
  return filePath
}
