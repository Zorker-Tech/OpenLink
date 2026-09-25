/**
 * What a transcript leaves out.
 *
 * A transcript is meant to be read back as the conversation, so the context the platform injected around
 * the user's own words — their profile, the project layout, the rules, the git status, the reminders — is
 * not part of it. Those blocks are tagged, so they are removed by tag, and the blank lines left behind are
 * collapsed afterwards rather than left as gaps in the middle of a message.
 */

export const CONTEXT_TAGS_TO_STRIP = [
  "user_info", "project_layout", "rules", "always_applied_workspace_rules", "agent_requestable_workspace_rules", "user_rules", "agent_skills", "available_skills",
  "cloud_instructions", "cloud_task_instructions", "open_and_recently_viewed_files", "system_reminder", "system-reminder", "mcp_instructions", "mcp_file_system",
  "mcp_file_system_servers", "git_status", "agent_transcripts", "cursor_rules_context", "attached_files", "system_notification", "task_notification", "agent_notification",
] as const

export function stripTags(text: string, tags: readonly string[]): string {
  let result = text
  // A tag may carry attributes, and may span lines, so the whole element is matched rather than the tag.
  for (const tag of tags) result = result.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "gi"), "")
  return result.replace(/\n{3,}/g, "\n\n").trim()
}
export const stripContextTags = (text: string): string => stripTags(text, CONTEXT_TAGS_TO_STRIP)
