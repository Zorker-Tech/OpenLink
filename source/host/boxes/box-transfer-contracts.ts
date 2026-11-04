export const SLATE_BOX_UPLOADS_DIR = "/workspace/uploads";
export const SLATE_BOX_WORKSPACE_ROOT = "/workspace";
export const BOX_PATH_ROOTS = ["/workspace", "/home", "/root"] as const;
export const DEFAULT_BOX_TRANSFER_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_BOX_TRANSFER_CONCURRENCY = 4;

export class BoxTransferError extends Error {
  override name = "BoxTransferError";
}

export class BoxFileUnreadableError extends Error {
  override name = "BoxFileUnreadableError";
}

export interface TransferBox {
  downloadFile(ctx: unknown, agentId: string, path: string): Promise<Uint8Array>;
  uploadFile(ctx: unknown, agentId: string, path: string, data: Uint8Array): Promise<void>;
}

export interface TransferEndpoint {
  readonly box: TransferBox;
  readonly agentId: string;
  readonly path: string;
  readonly label: string;
}
