export interface PluginSkillCatalogEntry {
  readonly sourceUrl?: string | null
}

export interface PluginCatalogEntry {
  readonly pluginId: string
  readonly skills: readonly PluginSkillCatalogEntry[]
}

export interface MaterializedPluginSkill {
  readonly pluginId: string
  readonly filePath: string
}

export interface LegacySkillReferenceRecord {
  readonly sourceRef?: string | null
  readonly body: string
}

const LEGACY_POINTER_SENTENCE = "is a live reference to the skill at"

export function isLiveReferencePointerBody(body: string): boolean {
  return body.includes(LEGACY_POINTER_SENTENCE)
}

/** Canonicalize provider blob URLs so different revisions point to the same materialized skill. */
export function normalizePluginSkillSourceUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  const [owner, repository, blobMarker, _revision, ...pathParts] = url.pathname.split("/").filter(Boolean)
  if (owner == null || repository == null || blobMarker !== "blob" || pathParts.length === 0) return raw
  return `${url.hostname.toLowerCase()}/${owner}/${repository}/${pathParts.join("/")}`
}

export function skillPathTail(path: string): string | null {
  const normalized = path.replaceAll("\\", "/")
  const skillsFolder = normalized.lastIndexOf("/skills/")
  return skillsFolder < 0 ? null : normalized.slice(skillsFolder + 1)
}

/** Match installed cache records to the catalog source entries whose pointers can be retired. */
export function collectMaterializedSkillSourceUrls(
  catalog: readonly PluginCatalogEntry[],
  records: readonly MaterializedPluginSkill[],
): string[] {
  const installed = new Set<string>()
  for (const record of records) {
    const tail = skillPathTail(record.filePath)
    if (tail !== null) installed.add(`${record.pluginId}\0${tail}`)
  }

  const sources: string[] = []
  for (const plugin of catalog) {
    for (const skill of plugin.skills) {
      if (skill.sourceUrl == null) continue
      const tail = skillPathTail(skill.sourceUrl)
      if (tail !== null && installed.has(`${plugin.pluginId}\0${tail}`)) sources.push(skill.sourceUrl)
    }
  }
  return sources
}

export function isLegacyReferenceForMaterializedSource(
  record: LegacySkillReferenceRecord,
  materializedSources: ReadonlySet<string>,
): boolean {
  return record.sourceRef != null &&
    materializedSources.has(normalizePluginSkillSourceUrl(record.sourceRef)) &&
    isLiveReferencePointerBody(record.body)
}
