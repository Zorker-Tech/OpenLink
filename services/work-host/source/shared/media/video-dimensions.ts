/** How large a video is, read from the container's own header. */
import type { MediaDimensions } from "./image-dimensions.ts";
import { findChildBoxContents, findNextBoxType, readMediaBox } from "./video-dimensions-boxes.ts";
import { dimensionsFromTrackHeader } from "./video-dimensions-track.ts";

export class Mp4Dimensions {
  public static read(bytes: Uint8Array): MediaDimensions | null {
    let searchOffset = 0;
    while (searchOffset + 4 <= bytes.length) {
      const typeOffset = findNextBoxType(bytes, "moov", searchOffset);
      if (typeOffset < 0) return null;

      const movieBox = readMediaBox(bytes, typeOffset - 4, bytes.length);
      const size = movieBox == null ? null : dimensionsFromMovie(bytes, movieBox.content);
      if (size != null) return size;
      searchOffset = typeOffset + 4;
    }
    return null;
  }
}

function dimensionsFromMovie(bytes: Uint8Array, movieContents: { readonly start: number; readonly end: number }): MediaDimensions | null {
  for (const track of findChildBoxContents(bytes, movieContents, "trak")) {
    const dimensions = dimensionsFromTrack(bytes, track);
    if (dimensions != null) return dimensions;
  }
  return null;
}

function dimensionsFromTrack(bytes: Uint8Array, track: { readonly start: number; readonly end: number }): MediaDimensions | null {
  for (const header of findChildBoxContents(bytes, track, "tkhd")) {
    const dimensions = dimensionsFromTrackHeader(bytes, header);
    if (dimensions != null) return dimensions;
  }
  return null;
}
