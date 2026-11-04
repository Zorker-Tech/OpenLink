import {
  clampWorkflowBody,
  clampWorkflowDescription,
  clampWorkflowName,
  parseWorkflowFile,
} from "../../../shared/workflow-model.ts";
import { isSafeFolderId } from "../../storage/folder-id.ts";
import type { ManagedSkill } from "./managed-skills-cache.ts";

export interface FetchedManagedSkill {
  readonly id: string;
  readonly description: string;
  readonly content: string;
  readonly enabled: boolean;
}

type ParsedSkillFile = ReturnType<typeof parseWorkflowFile>;

function cacheIdentifier(skill: FetchedManagedSkill): string | null {
  if (!skill.enabled) return null;
  const identifier = skill.id.trim();
  return isSafeFolderId(identifier) ? identifier : null;
}

function readableInstructions(source: string, document: ParsedSkillFile): string | null {
  const body = clampWorkflowBody(document?.body ?? source);
  return body.trim().length > 0 ? body : null;
}

function cacheName(documentName: string | undefined | null, identifier: string): string | null {
  const candidate = documentName != null && documentName.length > 0 ? documentName : identifier;
  const name = clampWorkflowName(candidate);
  return name.length > 0 ? name : null;
}

function cacheDescription(documentDescription: string | undefined | null, fetchedDescription: string): string {
  const candidate = documentDescription != null && documentDescription.length > 0
    ? documentDescription
    : fetchedDescription;
  return clampWorkflowDescription(candidate);
}

export function fetchedManagedSkillToSlateSkill(skill: FetchedManagedSkill): ManagedSkill | null {
  const id = cacheIdentifier(skill);
  if (id === null) return null;

  const document = parseWorkflowFile(skill.content);
  const body = readableInstructions(skill.content, document);
  if (body === null) return null;

  const name = cacheName(document?.name, id);
  if (name === null) return null;

  return {
    id,
    name,
    description: cacheDescription(document?.description, skill.description),
    body,
  };
}
