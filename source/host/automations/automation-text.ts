import { randomUUID } from "node:crypto";
import { clampLine, slugifyName } from "../../shared/slate-text.ts";
import { AUTOMATION_MAX_NAME_LENGTH } from "./automation-contracts.ts";

/** Keep a routine name on one readable line and within the persisted-name limit. */
function clampAutomationName(name: string): string {
  return clampLine(name, AUTOMATION_MAX_NAME_LENGTH);
}

/** Store the instruction without surrounding whitespace. */
function normalizeAutomationPrompt(prompt: string): string {
  return prompt.trim();
}

/** Produce the stable, filesystem-friendly part of a new routine's local folder name. */
function slugifyAutomationName(name: string): string {
  return slugifyName(name, "automation");
}

/** Give each run a fresh identifier before it enters the store. */
function createAutomationRunId(): string {
  return randomUUID();
}

export { clampAutomationName, normalizeAutomationPrompt, slugifyAutomationName, createAutomationRunId };
