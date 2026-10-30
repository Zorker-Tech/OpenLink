import 'server-only'

import { randomUUID } from 'node:crypto'

const APPLICATION_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,95}$/
const DATABASE_ERROR_CODE = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/

function getSafeErrorCode(error: unknown) {
  if (error instanceof Error && APPLICATION_ERROR_CODE.test(error.message)) {
    return error.message
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code
    if (typeof code === 'string' && DATABASE_ERROR_CODE.test(code)) {
      if (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(code)) {
        return `CHAT_SCHEMA_OUT_OF_DATE_${code}`
      }
      if (code === '42501') return 'CHAT_DATABASE_PERMISSION_DENIED'
      return `CHAT_DATABASE_ERROR_${code}`
    }
  }

  return 'CHAT_SESSION_CREATE_FAILED'
}

/** Log only a stable error code and opaque correlation ID; never raw DB text. */
export function reportChatFailure(stage: string, error: unknown) {
  const diagnosticId = randomUUID()
  const errorCode = getSafeErrorCode(error)
  console.error('[openlink-chat]', JSON.stringify({
    event: 'operation_failed',
    stage,
    errorCode,
    diagnosticId,
  }))
  return { errorCode, diagnosticId }
}

/** Add stage attribution to failures from Server Component data dependencies. */
export async function observeChatStage<T>(stage: string, result: PromiseLike<T> | T): Promise<T> {
  try {
    return await result
  } catch (error) {
    reportChatFailure(stage, error)
    throw error
  }
}
