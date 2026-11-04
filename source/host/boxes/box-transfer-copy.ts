import { DEFAULT_BOX_TRANSFER_MAX_BYTES, BoxTransferError, type TransferEndpoint } from "./box-transfer-contracts.ts";
import { errorDescription, isSourceMissingError } from "./box-transfer-failures.ts";

/** Move one file across box boundaries after the source has been read and size-checked. */
export async function transferFileBetweenBoxes(
  ctx: unknown,
  args: { readonly source: TransferEndpoint; readonly dest: TransferEndpoint; readonly maxBytes?: number },
): Promise<number> {
  const { source, dest } = args;
  let contents: Uint8Array;
  try {
    contents = await source.box.downloadFile(ctx, source.agentId, source.path);
  } catch (error) {
    if (isSourceMissingError(error)) {
      throw new BoxTransferError(`source file not found on ${source.label}: ${source.path}`, { cause: error });
    }
    throw new BoxTransferError(`failed to read ${source.path} from ${source.label}: ${errorDescription(error)}`, { cause: error });
  }

  const maximumBytes = args.maxBytes ?? DEFAULT_BOX_TRANSFER_MAX_BYTES;
  if (contents.byteLength > maximumBytes) {
    throw new BoxTransferError(`file is too large to transfer: ${source.path} on ${source.label} is ${contents.byteLength} bytes, over the ${maximumBytes}-byte limit`);
  }

  try {
    await dest.box.uploadFile(ctx, dest.agentId, dest.path, contents);
  } catch (error) {
    throw new BoxTransferError(`failed to write ${dest.path} on ${dest.label}: ${errorDescription(error)}`, { cause: error });
  }
  return contents.byteLength;
}
