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
 * and a lock that was granted in the same instant is released again — otherwise an aborted call would
 * leave a file locked forever. The lock is disposable, so the release happens even if the operation
 * throws.
 */

import type { Context } from "../../../context/context.ts"
import { ToolCallAbortedError } from "../tool-errors.ts"

interface FileWaiter {
  readonly type: "file"
  readonly path: string
  readonly resolve: () => void
}

interface ExclusiveWaiter {
  readonly type: "exclusive"
  readonly resolve: () => void
}

type Waiter = FileWaiter | ExclusiveWaiter

export interface FileOperationLock {
  /** The order this lock was taken in, when the caller asked for it; used to compare overlapping writes. */
  readonly acquisitionOrder: bigint | undefined
  [Symbol.dispose](): void
}

export interface ExclusiveFileOperationLock {
  [Symbol.dispose](): void
}

export class FileOperationLockManager {
  private readonly lockedFiles = new Set<string>()
  private exclusiveLockActive = false
  private readonly waitQueue: Waiter[] = []
  private nextAcquisitionOrder = 0n

  get activeFileOperationCount(): number {
    return this.lockedFiles.size
  }

  async waitForLock(
    ctx: Context,
    targetPath: string,
    options?: { readonly trackAcquisitionOrder?: boolean | undefined },
  ): Promise<FileOperationLock> {
    if (ctx.signal.aborted) throw new ToolCallAbortedError()
    const needsToWait = this.exclusiveLockActive ||
      this.lockedFiles.has(targetPath) ||
      this.hasExclusiveWaiterAhead()
    if (needsToWait) {
      let wasGranted = false
      await new Promise<void>(resolve => {
        const wrappedResolve = () => {
          wasGranted = true
          ctx.signal.removeEventListener("abort", onAbort)
          resolve()
        }
        const onAbort = () => {
          const index = this.waitQueue.findIndex(waiter =>
            waiter.type === "file" && waiter.path === targetPath && waiter.resolve === wrappedResolve)
          if (index >= 0) this.waitQueue.splice(index, 1)
          resolve()
        }
        ctx.signal.addEventListener("abort", onAbort, { once: true })
        this.waitQueue.push({ type: "file", path: targetPath, resolve: wrappedResolve })
      })
      if (ctx.signal.aborted) {
        // The lock may have been granted as the abort arrived; give it back rather than hold it.
        if (wasGranted) this.releaseFileLock(targetPath)
        throw new ToolCallAbortedError()
      }
    } else {
      this.lockedFiles.add(targetPath)
    }
    let released = false
    const dispose = () => {
      if (released) return
      released = true
      this.releaseFileLock(targetPath)
    }
    return {
      acquisitionOrder: options?.trackAcquisitionOrder === true ? ++this.nextAcquisitionOrder : undefined,
      [Symbol.dispose]: dispose,
    }
  }

  async waitForExclusiveLock(ctx: Context): Promise<ExclusiveFileOperationLock> {
    if (ctx.signal.aborted) throw new ToolCallAbortedError()
    const needsToWait = this.exclusiveLockActive || this.activeFileOperationCount > 0
    if (needsToWait) {
      let wasGranted = false
      await new Promise<void>(resolve => {
        const wrappedResolve = () => {
          wasGranted = true
          ctx.signal.removeEventListener("abort", onAbort)
          resolve()
        }
        const onAbort = () => {
          const index = this.waitQueue.findIndex(waiter => waiter.type === "exclusive" && waiter.resolve === wrappedResolve)
          if (index >= 0) this.waitQueue.splice(index, 1)
          resolve()
        }
        ctx.signal.addEventListener("abort", onAbort, { once: true })
        this.waitQueue.push({ type: "exclusive", resolve: wrappedResolve })
      })
      if (ctx.signal.aborted) {
        if (wasGranted) this.releaseExclusiveLock()
        throw new ToolCallAbortedError()
      }
    } else {
      this.exclusiveLockActive = true
    }
    let released = false
    const dispose = () => {
      if (released) return
      released = true
      this.releaseExclusiveLock()
    }
    return { [Symbol.dispose]: dispose }
  }

  private hasExclusiveWaiterAhead(): boolean {
    return this.waitQueue.some(waiter => waiter.type === "exclusive")
  }

  private releaseFileLock(pathKey: string): void {
    this.lockedFiles.delete(pathKey)
    this.processQueue()
  }

  private releaseExclusiveLock(): void {
    this.exclusiveLockActive = false
    this.processQueue()
  }

  /** Grants as much of the queue as the current state allows, stopping at the first waiter that cannot run. */
  private processQueue(): void {
    while (this.waitQueue.length > 0) {
      const front = this.waitQueue[0]!
      if (front.type === "exclusive") {
        if (this.activeFileOperationCount > 0 || this.exclusiveLockActive) break
        this.exclusiveLockActive = true
        this.waitQueue.shift()
        front.resolve()
        break
      }
      if (this.exclusiveLockActive || this.lockedFiles.has(front.path)) break
      this.lockedFiles.add(front.path)
      this.waitQueue.shift()
      front.resolve()
    }
  }
}
