/** External model-name fragments that currently use Slate's larger-context behavior. */
export const INTEROP_LARGE_CONTEXT_MODEL_MARKERS = ["dsv3", "kimi2p5", "kimi-k2p5", "titanium"] as const

export function isLargeContextModelName(modelName: string | null | undefined): boolean {
  if (!modelName) return false
  const normalized = modelName.toLowerCase()
  return INTEROP_LARGE_CONTEXT_MODEL_MARKERS.some(marker => normalized.includes(marker))
}
