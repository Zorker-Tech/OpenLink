const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PREVIEW_TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_PROJECT_TARGETS = 50
const MAX_PREVIEW_TARGETS = 250

function browserStorage() {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

function storageKey(userId, workspaceId, version = 3) {
  if (typeof userId !== 'string' || !PROJECT_ID_PATTERN.test(userId)
    || typeof workspaceId !== 'string' || !PROJECT_ID_PATTERN.test(workspaceId)) return null
  return `openlink:workspace-preview:v${version}:${userId.toLowerCase()}:${workspaceId.toLowerCase()}`
}

export function createEmptyWorkspacePreviewState() {
  return { version: 3, selectedProjectId: null, targetIds: {}, pagePaths: {}, viewportModes: {} }
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

  const allowedTargetIds = new Set(Object.values(targetIds))
  const rawPagePaths = raw.pagePaths && typeof raw.pagePaths === 'object' && !Array.isArray(raw.pagePaths)
    ? /** @type {Record<string, unknown>} */ (raw.pagePaths)
    : {}
  const pagePaths = {}
  for (const [targetId, path] of Object.entries(rawPagePaths).slice(-MAX_PREVIEW_TARGETS)) {
    if (allowedTargetIds.has(targetId)
      && typeof path === 'string'
      && path.length <= 2048
      && path.startsWith('/')
      && !path.startsWith('//')
      && !/[\\?#\u0000-\u001f\u007f]/.test(path)) {
      pagePaths[targetId] = path
    }
  }

  const rawViewportModes = raw.viewportModes && typeof raw.viewportModes === 'object' && !Array.isArray(raw.viewportModes)
    ? /** @type {Record<string, unknown>} */ (raw.viewportModes)
    : {}
  const viewportModes = {}
  for (const [targetId, mode] of Object.entries(rawViewportModes).slice(-MAX_PREVIEW_TARGETS)) {
    if (allowedTargetIds.has(targetId) && (mode === 'browser' || mode === 'mobile')) {
      viewportModes[targetId] = mode
    }
  }

  return {
    version: 3,
    selectedProjectId: selected && allowed.has(selected) ? selected : null,
    targetIds,
    pagePaths,
    viewportModes,
  }
}

/** @param {readonly string[]} allowedProjectIds @param {Pick<Storage, 'getItem'> | null} [storage] */
export function loadWorkspacePreviewState(userId, workspaceId, allowedProjectIds, storage = browserStorage()) {
  const key = storageKey(userId, workspaceId)
  if (!key || !storage) return null
  for (const candidateKey of [key, storageKey(userId, workspaceId, 2), storageKey(userId, workspaceId, 1)]) {
    try {
      const raw = candidateKey ? storage.getItem(candidateKey) : null
      if (raw) return sanitizeWorkspacePreviewState(JSON.parse(raw), allowedProjectIds)
    } catch {
      // Keep Preview usable when a storage implementation or stored version fails.
    }
  }
  return null
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
