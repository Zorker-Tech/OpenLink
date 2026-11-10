import { DEFAULT_BOX_TRANSFER_CONCURRENCY, type TransferBox } from "./box-transfer-contracts.ts";
import { forEachBounded } from "./box-transfer-concurrency.ts";

/** Download each requested path once and preserve the caller's first-seen path order. */
export async function downloadBoxFiles(
  ctx: unknown,
  box: TransferBox,
  agentId: string,
  boxPaths: readonly string[],
  options?: { readonly maxConcurrency?: number },
): Promise<Map<string, Uint8Array>> {
  const uniquePaths = [...new Set(boxPaths)];
  const contentsByPath = new Map<string, Uint8Array>();
  await forEachBounded(uniquePaths, options?.maxConcurrency ?? DEFAULT_BOX_TRANSFER_CONCURRENCY, async (path) => {
    contentsByPath.set(path, await box.downloadFile(ctx, agentId, path));
  });

  return new Map(uniquePaths.map((path) => {
    const contents = contentsByPath.get(path);
    if (contents === undefined) throw new Error(`download from box ${path} produced no bytes`);
    return [path, contents];
  }));
}

/** Upload only the first item for each box path and return paths in that same order. */
export async function uploadBoxFiles(
  ctx: unknown,
  box: TransferBox,
  agentId: string,
  uploads: readonly { readonly boxPath: string; readonly data: Uint8Array }[],
  options?: { readonly maxConcurrency?: number },
): Promise<string[]> {
  const seen = new Set<string>();
  const uniqueUploads = [] as typeof uploads[number][];
  for (const upload of uploads) {
    if (seen.has(upload.boxPath)) continue;
    seen.add(upload.boxPath);
    uniqueUploads.push(upload);
  }

  await forEachBounded(uniqueUploads, options?.maxConcurrency ?? DEFAULT_BOX_TRANSFER_CONCURRENCY, async (upload) => {
    await box.uploadFile(ctx, agentId, upload.boxPath, upload.data);
  });
  return uniqueUploads.map((upload) => upload.boxPath);
}
