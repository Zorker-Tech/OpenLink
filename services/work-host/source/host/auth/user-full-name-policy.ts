export function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed != null && trimmed.length > 0 ? trimmed : undefined
}

export function displayNameFrom(name: {
  readonly firstName?: string | undefined
  readonly lastName?: string | undefined
}): string | undefined {
  const parts = [name.firstName?.trim(), name.lastName?.trim()]
    .filter((part): part is string => part != null && part.length > 0)
  return parts.length > 0 ? parts.join(" ") : undefined
}
