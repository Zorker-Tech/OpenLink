/**
 * The sections a sidebar is grouped into.
 *
 * Sections are normalized before they are shown: a section with no name is dropped, two sections with the same id are
 * one, an agent belongs to the first section that claims it, and the section that holds everything unassigned is not a
 * section of its own. What comes out is what a surface can render without having to make those decisions itself.
 */
export const UNASSIGNED_SECTION_ID = "__agents__";
export const UNASSIGNED_SECTION_NAME = "Unassigned";

export interface SidebarSection {
  readonly id: string;
  readonly name: string;
  readonly agentIds: readonly string[];
  readonly isCollapsed?: boolean;
}

/** What a sidebar with no sections of its own is handed: one list, shared, never built again. */
const NO_SIDEBAR_SECTIONS: readonly SidebarSection[] = [];

/** The agents a section claims that no earlier section claimed, each once. */
function unclaimedAgentIds(agentIds: readonly string[], claimed: Set<string>): string[] {
  const kept: string[] = [];
  for (const agentId of agentIds) {
    if (agentId.length === 0 || claimed.has(agentId)) continue;
    claimed.add(agentId);
    kept.push(agentId);
  }
  return kept;
}

/** A section as it is stored, or nothing when what was stored is not one. */
function readSection(value: unknown): SidebarSection | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  return {
    id: record.id,
    name: typeof record.name === "string" ? record.name : "",
    agentIds: Array.isArray(record.agentIds) ? record.agentIds.filter((id): id is string => typeof id === "string") : [],
  };
}

/** The folds a section was last seen with, by its id; the newest sighting wins. */
function foldsById(sections: readonly SidebarSection[]): Map<string, boolean> {
  const folds = new Map<string, boolean>();
  for (const section of sections) {
    if (section.isCollapsed !== undefined) folds.set(section.id.trim(), section.isCollapsed);
  }
  return folds;
}

export class SidebarGrouping {
  /**
   * The sections a surface can render: each id once, each agent in the first section that claims it, and the
   * unassigned section last — holding nothing, because what is unassigned is what no section claimed.
   */
  static cleaned(sections: readonly SidebarSection[]): readonly SidebarSection[] {
    const seenSectionIds = new Set<string>();
    const claimedAgentIds = new Set<string>();
    const normalized: SidebarSection[] = [];
    for (const section of sections) {
      const id = section.id.trim();
      if (id.length === 0 || seenSectionIds.has(id)) continue;
      seenSectionIds.add(id);
      // The unassigned section is added below, whatever a stored sidebar said about it.
      if (id === UNASSIGNED_SECTION_ID) continue;
      normalized.push({ id, name: section.name, agentIds: unclaimedAgentIds(section.agentIds, claimedAgentIds) });
    }
    if (normalized.length === 0) return NO_SIDEBAR_SECTIONS;
    normalized.push({ id: UNASSIGNED_SECTION_ID, name: UNASSIGNED_SECTION_NAME, agentIds: [] });
    return normalized;
  }

  /** The sections a stored sidebar holds, read from whatever was stored and then normalized. */
  static readFrom(value: readonly unknown[]): readonly SidebarSection[] {
    const records: SidebarSection[] = [];
    for (const entry of value) {
      const section = readSection(entry);
      if (section !== null) records.push(section);
    }
    return SidebarGrouping.cleaned(records);
  }

  /** The same sections, each saying whether it is folded. */
  static folded(sections: readonly SidebarSection[], collapsedSectionIds: readonly string[]): SidebarSection[] {
    const collapsed = new Set(collapsedSectionIds);
    return sections.map((section) => ({ ...section, isCollapsed: collapsed.has(section.id) }));
  }

  /** The sections as they are now, each folded the way it was last stored or shown. */
  static foldsCarried(args: { readonly sections: readonly SidebarSection[]; readonly stored?: readonly SidebarSection[] }): SidebarSection[] {
    const folds = foldsById([...(args.stored ?? []), ...args.sections]);
    return SidebarGrouping.cleaned(args.sections).map((section) => ({ ...section, isCollapsed: folds.get(section.id) ?? false }));
  }
}
