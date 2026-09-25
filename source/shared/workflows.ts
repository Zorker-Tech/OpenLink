/**
 * The workflow surface a caller can hit.
 *
 * Publishing a skill can be refused, and a refusal travels as its own error so the caller can tell it from a failure
 * of the platform: the reason is what the refusal was, and the prefix is what makes it recognizable in a message. A
 * workflow may also refer to another node rather than embedding it, which is what the reference node type names.
 */
export const SLATE_SKILL_PUBLISH_REFUSED = "skill-publish/refused"; export const SKILL_PUBLISH_REFUSAL_PREFIX = `${SLATE_SKILL_PUBLISH_REFUSED}: `; export class SlateSkillPublishError extends Error { constructor(reason: string) { super(`${SKILL_PUBLISH_REFUSAL_PREFIX}${reason}`); this.name = "SlateSkillPublishError"; } } export const WORKFLOW_REFERENCE_NODE_TYPE = "workflowReference";
