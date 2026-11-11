let counter = 0

export function uniqueId(prefix: string) {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}
