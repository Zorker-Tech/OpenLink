/**
 * One writer per file at a time, and one operation that needs the whole workspace to itself.
 *
 * Several tool calls can run at once, and two of them writing the same file would interleave. So a call
 * takes a lock on the path it is about to touch, and a call that needs to see the whole workspace
 * consistently takes an exclusive lock that no per-file lock may be held under.
 *
 * The queue is fair in the way that matters: a waiting exclusive lock blocks later per-file locks, so a
 * long stream of small writes cannot starve the one operation that needs everything to stop. A caller
 * that is cancelled while waiting leaves the queue rather than being granted a lock it no longer wants,
 * and a lock that was granted in the same instant is disposed again — otherwise an aborted call would
 * leave a file locked forever. The lock is disposable, so the release happens even if the operation
 * throws.
 */

import type { Context } from "../../../context/context.ts"
import { ToolCallAbortedError } from "../tool-errors.ts"

interface PathWaiter {
  readonly type: "file"
  readonly path: string
  readonly resolve: () => void
}

interface WorkspaceWaiter {
  readonly type: "exclusive"
  readonly resolve: () => void
}

type QueueEntry = PathWaiter | WorkspaceWaiter

export interface FileOperationLock {
  /** The order this lock was taken in, when the caller asked for it; used to compare overlapping writes. */
  readonly acquisitionOrder: bigint | undefined
  [Symbol.dispose](): void
}

export interface ExclusiveFileOperationLock {
  [Symbol.dispose](): void
}

export class FileOperationLockManager {
  private readonly heldPaths = new Set<string>()
  private workspaceHeld = false
  private readonly pendingQueue: QueueEntry[] = []
  private acquisitionCounter = 0n

  get activeFileOperationCount(): number {
    return this.heldPaths.size
  }

  async waitForLock(
    ctx: Context,
    requestedPath: string,
    settings?: { readonly trackAcquisitionOrder?: boolean | undefined },
  ): Promise<FileOperationLock> {
    if (ctx.signal.aborted) throw new ToolCallAbortedError()
    const mustWait = this.workspaceHeld ||
      this.heldPaths.has(requestedPath) ||
      this.hasWorkspaceWaiterAhead()
    if (mustWait) {
      let grantedWhileWaiting = false
      await new Promise<void>(resolve => {
        const grantPath = () => {
          grantedWhileWaiting = true
          ctx.signal.removeEventListener("abort", abortListener)
          resolve()
        }
        const abortListener = () => {
          const index = this.pendingQueue.findIndex(entry =>
            entry.type === "file" && entry.path === requestedPath && entry.resolve === grantPath)
          if (index >= 0) this.pendingQueue.splice(index, 1)
          resolve()
        }
        ctx.signal.addEventListener("abort", abortListener, { once: true })
        this.pendingQueue.push({ type: "file", path: requestedPath, resolve: grantPath })
      })
      if (ctx.signal.aborted) {
        // The lock may have been granted as the abort arrived; give it back rather than hold it.
        if (grantedWhileWaiting) this.releasePathLock(requestedPath)
        throw new ToolCallAbortedError()
      }
    } else {
      this.heldPaths.add(requestedPath)
    }
    let disposed = false
    const releaseOnce = () => {
      if (disposed) return
      disposed = true
      this.releasePathLock(requestedPath)
    }
    return {
      acquisitionOrder: settings?.trackAcquisitionOrder === true ? ++this.acquisitionCounter : undefined,
      [Symbol.dispose]: releaseOnce,
    }
  }

  async waitForExclusiveLock(ctx: Context): Promise<ExclusiveFileOperationLock> {
    if (ctx.signal.aborted) throw new ToolCallAbortedError()
    const mustWait = this.workspaceHeld || this.activeFileOperationCount > 0
    if (mustWait) {
      let grantedWhileWaiting = false
      await new Promise<void>(resolve => {
        const grantPath = () => {
          grantedWhileWaiting = true
          ctx.signal.removeEventListener("abort", abortListener)
          resolve()
        }
        const abortListener = () => {
          const index = this.pendingQueue.findIndex(entry => entry.type === "exclusive" && entry.resolve === grantPath)
          if (index >= 0) this.pendingQueue.splice(index, 1)
          resolve()
        }
        ctx.signal.addEventListener("abort", abortListener, { once: true })
        this.pendingQueue.push({ type: "exclusive", resolve: grantPath })
      })
      if (ctx.signal.aborted) {
        if (grantedWhileWaiting) this.releaseWorkspaceLock()
        throw new ToolCallAbortedError()
      }
    } else {
      this.workspaceHeld = true
    }
    let disposed = false
    const releaseOnce = () => {
      if (disposed) return
      disposed = true
      this.releaseWorkspaceLock()
    }
    return { [Symbol.dispose]: releaseOnce }
  }

  private hasWorkspaceWaiterAhead(): boolean {
    return this.pendingQueue.some(entry => entry.type === "exclusive")
  }

  private releasePathLock(releasedPath: string): void {
    this.heldPaths.delete(releasedPath)
    this.grantQueued()
  }

  private releaseWorkspaceLock(): void {
    this.workspaceHeld = false
    this.grantQueued()
  }

  /** Grants as much of the queue as the current state allows, stopping at the first entry that cannot run. */
  private grantQueued(): void {
    while (this.pendingQueue.length > 0) {
      const head = this.pendingQueue[0]!
      if (head.type === "exclusive") {
        if (this.activeFileOperationCount > 0 || this.workspaceHeld) break
        this.workspaceHeld = true
        this.pendingQueue.shift()
        head.resolve()
        break
      }
      if (this.workspaceHeld || this.heldPaths.has(head.path)) break
      this.heldPaths.add(head.path)
      this.pendingQueue.shift()
      head.resolve()
    }
  }
}
