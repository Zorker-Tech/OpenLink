import { readFile } from "node:fs/promises";

import { imageMimeFromPath } from "../shared/media/image-mime.ts";

export interface SelectedImageInput {
  data: Uint8Array<ArrayBuffer>;
  path: string;
  mimeType: string | undefined;
}

function describeImageBytes(attachmentPath: string, sourceBytes: Uint8Array): SelectedImageInput {
  return {
    data: Uint8Array.from(sourceBytes),
    path: attachmentPath,
    mimeType: imageMimeFromPath(attachmentPath),
  };
}

async function readImageInput(attachmentPath: string): Promise<SelectedImageInput | null> {
  try {
    const sourceBytes = await readFile(attachmentPath);
    return describeImageBytes(attachmentPath, sourceBytes);
  } catch {
    return null;
  }
}

function isReadableImage(input: SelectedImageInput | null): input is SelectedImageInput {
  return input !== null;
}

export async function loadSelectedImageInputs(
  attachmentPaths: readonly string[],
): Promise<SelectedImageInput[]> {
  if (attachmentPaths.length === 0) return [];

  const attempts = await Promise.all(attachmentPaths.map(readImageInput));
  return attempts.filter(isReadableImage);
}
