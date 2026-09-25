/**
 * Whether something is meant for the environment a run is happening in.
 *
 * The same rules, skills and plugins are shared across the environments a platform runs in — a
 * developer's machine and the cloud — and most of them apply everywhere. A few do not: a rule written
 * for the cloud may be meaningless locally, and one written for a local machine may be unsafe where
 * there is no user watching. An item says which environments it wants, or which it refuses, and this
 * decides whether the current one is among them.
 *
 * A refusal wins over a request, because the two can both be present and the safer reading is the one
 * that keeps the item out. An item that asks for nothing applies everywhere.
 */

export interface EnvironmentScopedItem {
  readonly disabledEnvironments?: readonly string[] | undefined
  readonly environments?: readonly string[] | undefined
}

function isEnvironmentEligible(item: EnvironmentScopedItem, targetEnv: string): boolean {
  const disabledEnvironments = item.disabledEnvironments ?? []
  if (disabledEnvironments.includes(targetEnv)) return false
  const environments = item.environments ?? []
  if (environments.length === 0) return true
  return environments.includes(targetEnv)
}

export function filterByEnvironment<T extends EnvironmentScopedItem>(items: T[], targetEnv: string): T[] {
  return items.filter(item => isEnvironmentEligible(item, targetEnv))
}
