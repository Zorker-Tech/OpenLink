export type LogShipResult =
  | { readonly delivered: true; readonly receipt?: { logsProcessed: number; logsDropped: number } }
  | { readonly delivered: false; readonly error: unknown }

export interface LogShipBufferedEntry {
  readonly message: string
  readonly metadata: Readonly<Record<string, string>>
}
