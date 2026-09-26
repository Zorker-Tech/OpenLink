/**
 * A skill the platform manages, turned into one the agent can read.
 *
 * What is fetched has to be enabled, carry a safe folder id and hold a body once the workflow file's own parts are
 * parsed; the name falls back to the id, and what the agent reads is bounded like any other workflow file.
 */
import { clampWorkflowBody, clampWorkflowDescription, clampWorkflowName, parseWorkflowFile } from "../../../shared/workflow-model.ts";
import { isSafeFolderId } from "../../storage/folder-id.ts";
import type { ManagedSkill } from "./managed-skills-cache.ts";

export interface FetchedManagedSkill { id: string; description: string; content: string; enabled: boolean }

export function fetchedManagedSkillToSlateSkill(skill: FetchedManagedSkill): ManagedSkill | null {
  if (!skill.enabled) return null;
  const id = skill.id.trim(); if (!isSafeFolderId(id)) return null;
  const parsed = parseWorkflowFile(skill.content); const body = clampWorkflowBody(parsed?.body ?? skill.content); if (body.trim().length === 0) return null;
  const name = clampWorkflowName(parsed?.name != null && parsed.name.length > 0 ? parsed.name : id); if (name.length === 0) return null;
  return { id, name, description: clampWorkflowDescription(parsed?.description != null && parsed.description.length > 0 ? parsed.description : skill.description), body };
}
