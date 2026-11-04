export function slateErrorDetail(error: unknown): { message: string; stack?: string } {
  if (!(error instanceof Error)) return { message: String(error) }
  return { message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) }
}
