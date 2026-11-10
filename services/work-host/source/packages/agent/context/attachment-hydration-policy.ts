export function enforceAttachmentByteLimit(input: {
  readonly data: Uint8Array
  readonly maxBytes: number | undefined
  readonly label: string
}): void {
  if (input.maxBytes !== undefined && input.data.length > input.maxBytes) {
    throw new Error(`${input.label} exceeds maximum size of ${input.maxBytes} bytes (${Math.round(input.maxBytes / 1024 / 1024)}MB)`)
  }
}
