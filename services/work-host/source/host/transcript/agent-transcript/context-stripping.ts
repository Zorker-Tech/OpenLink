/**
 * What a transcript leaves out.
 *
 * A transcript is meant to be read back as the conversation, so the context the platform injected around the user's
 * own words — their profile, the project layout, the rules, the git status, the reminders — is not part of it. Those
 * blocks are tagged, so they are removed by tag, and the blank lines left behind are collapsed afterwards rather than
 * left as gaps in the middle of a message.
 */

import { LEGACY_INTEROP_CONTEXT_TAG_ALIASES } from "../../../adapters/interop/agent/legacy-context-tag-adapter.ts";

/** Current Slate context tags plus historical interop aliases; their content is not part of the conversation. */
export const CONTEXT_TAGS_TO_STRIP = [
  "user_info", "project_layout", "rules", "always_applied_workspace_rules", "agent_requestable_workspace_rules", "user_rules", "agent_skills", "available_skills",
  "cloud_instructions", "cloud_task_instructions", "open_and_recently_viewed_files", "workspace_editor_context", "system_reminder", "system-reminder", "mcp_instructions", "mcp_file_system",
  "mcp_file_system_servers", "git_status", "agent_transcripts", "workspace_rules_context", ...LEGACY_INTEROP_CONTEXT_TAG_ALIASES, "attached_files", "system_notification", "task_notification", "agent_notification",
] as const;

/** The whole element of one tagged block: the opening tag with any attributes, its content across lines, its closing tag. */
function blockElementPattern(tag: string): RegExp {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "gi");
}

/** A text with every run of blank lines cut down to one blank line between paragraphs. */
function withoutBlankGaps(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/** A text with every block of the given tags taken out, its blank gaps left tidy. */
export function stripTags(content: string, blockTags: readonly string[]): string {
  let stripped = content;
  for (const tag of blockTags) stripped = stripped.replace(blockElementPattern(tag), "");
  return withoutBlankGaps(stripped).trim();
}

/** A transcript text with the context the platform injected around it taken out. */
export const stripContextTags = (content: string): string => stripTags(content, CONTEXT_TAGS_TO_STRIP);
