/** Workspace file transfer and protected-store checks for a loopback box. */
import { readFile } from "node:fs/promises";
import type { Context } from "../../packages/context/context.ts";
import { findSystemErrno } from "../../shared/system-errno.ts";
import { assertPathOutsideProtectedRoots } from "./protected-path-guard.ts";
import type { BoxEnvironmentUpdate } from "./box-env.ts";
import { BoxFileUnreadableError, resolveBoxWorkspacePath } from "./box-transfer.ts";
import type { LoopbackOperations } from "./loopback-box-contracts.ts";
import type { ShellAccessor } from "./box-windows.ts";

export interface ReadyBoxAccessor<Accessor extends ShellAccessor> {
  remoteAccessor: Accessor;
  vncUrl: string;
  terminalsFolder: string;
}

export interface LoopbackFileAccessDependencies<Accessor extends ShellAccessor> {
  protectedPaths: readonly string[];
  operations: Pick<LoopbackOperations<Accessor>, "protectRemoteAccessor" | "uploadFile">;
  ensureReady(ctx: Context, agentId: string): Promise<ReadyBoxAccessor<Accessor>>;
}

export class LoopbackBoxFileAccess<Accessor extends ShellAccessor> {
  constructor(private readonly dependencies: LoopbackFileAccessDependencies<Accessor>) {}

  async assertFileReadAllowed(boxPath: string): Promise<void> {
    await assertPathOutsideProtectedRoots(this.dependencies.protectedPaths, boxPath, "/workspace");
  }

  protectRemoteAccessor(accessor: Accessor): Accessor {
    return this.dependencies.operations.protectRemoteAccessor(accessor, path => this.assertFileReadAllowed(path));
  }

  async upload(ctx: Context, agentId: string, boxPath: string, bytes: Uint8Array): Promise<void> {
    const ready = await this.dependencies.ensureReady(ctx, agentId);
    const upload = this.dependencies.operations.uploadFile;
    if (upload === undefined) throw new Error("loopback upload transport is unavailable");
    await upload(ctx, ready.remoteAccessor, resolveBoxWorkspacePath(boxPath), bytes);
  }

  async download(boxPath: string): Promise<Buffer> {
    const resolved = resolveBoxWorkspacePath(boxPath);
    await this.assertFileReadAllowed(resolved);
    try {
      return await readFile(resolved);
    } catch (error) {
      if (findSystemErrno(error) === "ENOENT") {
        throw new BoxFileUnreadableError(`download from box ${resolved} failed (file missing)`, { cause: error });
      }
      throw error;
    }
  }
}
