export function connectorMessageFromEmission(emission: {
  readonly connector: string
  readonly serverId: string
  readonly variant: string
}) {
  return {
    type: "connector" as const,
    connector: emission.connector,
    serverId: emission.serverId,
    variant: emission.variant,
  }
}
