export const KNOWN_CONNECTOR_TAGS = new Set([
  "asana", "atlassian", "buildkite", "confluence", "context7", "databricks", "datadog", "deepwiki",
  "dock", "figma", "filesystem", "github", "gmail", "google", "googlecalendar", "googledocs",
  "googledrive", "googlesheets", "googleworkspace", "huggingface", "jira", "linear", "memory",
  "notion", "playwright", "salesforce", "sentry", "sequentialthinking", "slack", "stripe", "telegram",
  "todoist", "zoominfo",
]);

export const OTHER_CONNECTOR_TAG = "other";
export const UNKNOWN_CONNECTOR_TAG = "unknown";

export function boundedConnectorTag(serverName?: string): string {
  if (serverName === undefined) return UNKNOWN_CONNECTOR_TAG;
  const normalized = serverName.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (normalized.length === 0) return UNKNOWN_CONNECTOR_TAG;
  return KNOWN_CONNECTOR_TAGS.has(normalized) ? normalized : OTHER_CONNECTOR_TAG;
}
