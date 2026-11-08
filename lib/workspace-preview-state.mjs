const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PREVIEW_TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_PROJECT_TARGETS = 50

function browserStorage() {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

function storageKey(userId, workspaceId) {
  if (typeof userId !== 'string' || !PROJECT_ID_PATTERN.test(userId)
    || typeof workspaceId !== 'string' || !PROJECT_ID_PATTERN.test(workspaceId)) return null
  return `openlink:workspace-preview:v1:${userId.toLowerCase()}:${workspaceId.toLowerCase()}`
}

export function createEmptyWorkspacePreviewState() {
  return { version: 1, selectedProjectId: null, targetIds: {} }
}

/** @param {unknown} value @param {readonly string[]} allowedProjectIds */
export function sanitizeWorkspacePreviewState(value, allowedProjectIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createEmptyWorkspacePreviewState()
  const raw = /** @type {Record<string, unknown>} */ (value)
  const allowed = new Set(allowedProjectIds.filter((id) => PROJECT_ID_PATTERN.test(id)).map((id) => id.toLowerCase()))
  const selected = typeof raw.selectedProjectId === 'string' && PROJECT_ID_PATTERN.test(raw.selectedProjectId)
    ? raw.selectedProjectId.toLowerCase()
    : null
  const rawTargetIds = raw.targetIds && typeof raw.targetIds === 'object' && !Array.isArray(raw.targetIds)
    ? /** @type {Record<string, unknown>} */ (raw.targetIds)
    : {}
  const targetIds = {}

  for (const [projectId, targetId] of Object.entries(rawTargetIds).slice(-MAX_PROJECT_TARGETS)) {
    const normalizedProjectId = projectId.toLowerCase()
    if (allowed.has(normalizedProjectId) && typeof targetId === 'string' && PREVIEW_TARGET_ID_PATTERN.test(targetId)) {
      targetIds[normalizedProjectId] = targetId
    }
  }

  return {
    version: 1,
    selectedProjectId: selected && allowed.has(selected) ? selected : null,
    targetIds,
  }
}

/** @param {readonly string[]} allowedProjectIds @param {Pick<Storage, 'getItem'> | null} [storage] */
export function loadWorkspacePreviewState(userId, workspaceId, allowedProjectIds, storage = browserStorage()) {
  const key = storageKey(userId, workspaceId)
  if (!key || !storage) return null
  try {
    const raw = storage.getItem(key)
    return raw ? sanitizeWorkspacePreviewState(JSON.parse(raw), allowedProjectIds) : null
  } catch {
    return null
  }
}

/** @param {readonly string[]} allowedProjectIds @param {Pick<Storage, 'setItem'> | null} [storage] */
export function saveWorkspacePreviewState(userId, workspaceId, state, allowedProjectIds, storage = browserStorage()) {
  const key = storageKey(userId, workspaceId)
  if (!key || !storage) return false
  try {
    storage.setItem(key, JSON.stringify(sanitizeWorkspacePreviewState(state, allowedProjectIds)))
    return true
  } catch {
    return false
  }
}
