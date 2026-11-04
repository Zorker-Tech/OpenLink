import { ensureFinitePositive } from "./validation.ts"
import type { AgentStoreRetryConfiguration, ResolvedAgentStoreRetryConfiguration } from "./retry-schedule-contracts.ts"

const DEFAULT_GROWTH_FACTOR = 2
const DEFAULT_JITTER_FRACTION = 0

export function resolveAgentStoreRetryConfiguration(
  options: AgentStoreRetryConfiguration,
): ResolvedAgentStoreRetryConfiguration {
  const initialDelayMs = ensureFinitePositive({
    value: options.initialDelayMs,
    name: "initialDelayMs",
    context: "AgentStoreRetrySchedule",
  })
  const maximumDelayMs = ensureFinitePositive({
    value: options.maximumDelayMs,
    name: "maximumDelayMs",
    context: "AgentStoreRetrySchedule",
  })
  if (initialDelayMs > maximumDelayMs) {
    throw new RangeError(`AgentStoreRetrySchedule initialDelayMs (${initialDelayMs}) must not exceed maximumDelayMs (${maximumDelayMs})`)
  }

  const growthFactor = options.growthFactor !== undefined ? options.growthFactor : DEFAULT_GROWTH_FACTOR
  if (!Number.isFinite(growthFactor) || growthFactor < 1) {
    throw new RangeError(`AgentStoreRetrySchedule growthFactor must be at least 1, got ${growthFactor}`)
  }

  const jitterFraction = options.jitterFraction !== undefined ? options.jitterFraction : DEFAULT_JITTER_FRACTION
  if (!Number.isFinite(jitterFraction) || jitterFraction < 0 || jitterFraction > 1) {
    throw new RangeError(`AgentStoreRetrySchedule jitterFraction must be between 0 and 1, got ${jitterFraction}`)
  }

  return {
    initialDelayMs,
    maximumDelayMs,
    growthFactor,
    jitterFraction,
    randomSample: options.randomSample !== undefined ? options.randomSample : Math.random,
  }
}

function boundExponentialDelay(failureNumber: number, config: ResolvedAgentStoreRetryConfiguration): number {
  if (failureNumber <= 0) return 0
  return Math.min(
    config.initialDelayMs * Math.pow(config.growthFactor, failureNumber - 1),
    config.maximumDelayMs,
  )
}

function boundedRandomSample(sample: number): number {
  return Number.isFinite(sample) ? Math.max(0, Math.min(sample, 1)) : 0
}

export function retryDelayWithoutJitter(
  failureNumber: number,
  config: ResolvedAgentStoreRetryConfiguration,
): number {
  if (failureNumber <= 0) return 0
  return Math.min(config.maximumDelayMs, Math.max(1, Math.floor(boundExponentialDelay(failureNumber, config))))
}

export function retryDelayWithJitter(
  failureNumber: number,
  config: ResolvedAgentStoreRetryConfiguration,
): number {
  if (failureNumber <= 0) return 0
  if (config.jitterFraction === 0) return retryDelayWithoutJitter(failureNumber, config)
  const delay = boundExponentialDelay(failureNumber, config)
  const random = boundedRandomSample(config.randomSample())
  const varied = delay * (1 - config.jitterFraction + random * 2 * config.jitterFraction)
  return Math.min(config.maximumDelayMs, Math.max(1, Math.floor(varied)))
}
