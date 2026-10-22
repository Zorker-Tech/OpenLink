/**
 * Whether a file's first bytes say it is a video container.
 *
 * The markers are the ones the common containers start with, some as text at an offset and some as bytes, and a file
 * that carries one is treated as a video whatever its name says.
 */

/** The containers whose marker is text at a fixed offset. */
export const ASCII_MARKERS=[{offset:4,text:"ftyp"},{offset:0,text:"OggS"},{offset:0,text:"FLV"},{offset:8,text:"AVI "}]as const;

/** The containers whose marker is a byte sequence at the start of the file. */
export const BYTE_MARKERS:readonly(readonly number[])[]=[[26,69,223,163],[48,38,178,117],[0,0,1,186],[0,0,1,179]];

/** Whether these bytes carry this text at this offset. */
export function hasAsciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.byteLength < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

/** Whether these bytes carry the text marker at the offset the marker names. */
function matchesAsciiMarker(bytes: Uint8Array, marker: (typeof ASCII_MARKERS)[number]): boolean {
  return hasAsciiAt(bytes, marker.offset, marker.text);
}

/** Whether these bytes begin with this byte sequence. */
function startsWithBytes(bytes: Uint8Array, marker: readonly number[]): boolean {
  if (!(bytes.byteLength >= marker.length)) return false;
  return marker.every((byte, index) => bytes[index] === byte);
}

/** Whether a file's first bytes say it is a video container. */
export function bytesLookLikeVideoContainer(bytes: Uint8Array): boolean {
  return ASCII_MARKERS.some((marker) => matchesAsciiMarker(bytes, marker)) || BYTE_MARKERS.some((marker) => startsWithBytes(bytes, marker));
}
