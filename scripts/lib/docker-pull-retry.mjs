const RETRYABLE_PULL_ERROR = /(?:\bEOF\b|TLS|timed?\s*out|timeout|connection\s+(?:reset|closed|refused)|temporar(?:y|ily)|too many requests|\b429\b|\b50[0-4]\b|failed to authorize|failed to fetch oauth token)/i

export function isRetryableDockerPullError(error) {
  const detail = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n')
  return RETRYABLE_PULL_ERROR.test(detail)
}

export async function retryDockerPull(pull, options = {}) {
  const attempts = options.attempts ?? 8
  const delay = options.delay ?? ((attempt) => Math.min(attempt * 2_000, 15_000))
  const sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)))
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) {
    throw new Error('Docker image pull attempts must be an integer between 1 and 20')
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await pull()
    } catch (error) {
      if (attempt === attempts || !isRetryableDockerPullError(error)) throw error
      options.onRetry?.(attempt, attempts, error)
      await sleep(delay(attempt))
    }
  }
  throw new Error('Docker image pull retry loop terminated unexpectedly')
}
