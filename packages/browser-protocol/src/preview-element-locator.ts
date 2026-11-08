import type { ElementReference, PreviewElementLocator, PreviewElementLocatorCandidate } from './index.ts'

const TAG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const CANDIDATE_KINDS = new Set<PreviewElementLocatorCandidate['kind']>(['data-testid', 'data-test', 'data-cy', 'id', 'css'])

function isLocatorValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000
    && !/[\u0000-\u001f\u007f]/.test(value)
}

export function isPreviewElementLocator(value: unknown): value is PreviewElementLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const locator = value as Record<string, unknown>
  if (Object.keys(locator).some((key) => !['version', 'tagName', 'candidates'].includes(key))) return false
  if (locator.version !== 1 || typeof locator.tagName !== 'string' || !TAG_PATTERN.test(locator.tagName)
    || !Array.isArray(locator.candidates) || locator.candidates.length < 1 || locator.candidates.length > 5) return false
  const seen = new Set<string>()
  for (const rawCandidate of locator.candidates) {
    if (!rawCandidate || typeof rawCandidate !== 'object' || Array.isArray(rawCandidate)) return false
    const candidate = rawCandidate as Record<string, unknown>
    if (Object.keys(candidate).some((key) => !['kind', 'value'].includes(key))) return false
    if (!CANDIDATE_KINDS.has(candidate.kind as PreviewElementLocatorCandidate['kind']) || !isLocatorValue(candidate.value)) return false
    const identity = `${candidate.kind}\0${candidate.value}`
    if (seen.has(identity)) return false
    seen.add(identity)
  }
  return true
}

/** Build a privacy-bounded locator from attributes collected by the bridge. */
export function createPreviewElementLocator(element: Pick<ElementReference, 'tagName' | 'selector' | 'attributes'>): PreviewElementLocator | null {
  const tagName = element.tagName.toLowerCase()
  if (!TAG_PATTERN.test(tagName)) return null
  const attributes = element.attributes && typeof element.attributes === 'object' ? element.attributes : {}
  const candidates: PreviewElementLocatorCandidate[] = []
  const add = (kind: PreviewElementLocatorCandidate['kind'], value: unknown) => {
    if (isLocatorValue(value) && !candidates.some((candidate) => candidate.kind === kind && candidate.value === value)) {
      candidates.push({ kind, value })
    }
  }
  add('data-testid', attributes['data-testid'])
  add('data-test', attributes['data-test'])
  add('data-cy', attributes['data-cy'])
  add('id', attributes.id)
  add('css', element.selector)
  const locator = { version: 1 as const, tagName, candidates: candidates.slice(0, 5) }
  return isPreviewElementLocator(locator) ? locator : null
}
