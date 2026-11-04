import { fileURLToPath } from "node:url"
import { imageMimeFromPath } from "../../shared/media/image-mime.ts"

export type ChannelAttachmentAddress =
  | { readonly kind: "remote"; readonly image: boolean }
  | { readonly kind: "local"; readonly path: string }

function asUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

export function localPathFromChannelAddress(value: string): string | null {
  const address = asUrl(value)
  if (address === undefined) return value.length === 0 ? null : value
  if (address.protocol !== "file:") return null
  try {
    return fileURLToPath(address)
  } catch {
    return null
  }
}

export function isChannelImageAddress(value: string): boolean {
  const address = asUrl(value)
  return address !== undefined && imageMimeFromPath(address.pathname) != null
}

export function classifyChannelAttachmentAddress(value: string): ChannelAttachmentAddress | null {
  const address = asUrl(value)
  if (address?.protocol === "https:" || address?.protocol === "http:") {
    return { kind: "remote", image: imageMimeFromPath(address.pathname) != null }
  }
  const path = localPathFromChannelAddress(value)
  return path === null ? null : { kind: "local", path }
}
