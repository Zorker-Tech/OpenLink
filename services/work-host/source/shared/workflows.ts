/** Values shared by the host's workflow records and publish commands. */
const SKILL_PUBLISH_REFUSAL = {
  code: "skill-publish/refused",
  errorName: "SlateSkillPublishError",
  separator: ": ",
} as const;

const REFERENCE_NODE_NAME = "workflowReference" as const;

export const SLATE_SKILL_PUBLISH_REFUSED = SKILL_PUBLISH_REFUSAL.code;
export const SKILL_PUBLISH_REFUSAL_PREFIX = `${SKILL_PUBLISH_REFUSAL.code}${SKILL_PUBLISH_REFUSAL.separator}`;
export const WORKFLOW_REFERENCE_NODE_TYPE = REFERENCE_NODE_NAME;

function refusalMessage(reason: string): string {
  return `${SKILL_PUBLISH_REFUSAL_PREFIX}${reason}`;
}

export class SlateSkillPublishError extends Error {
  constructor(reason: string) {
    super(refusalMessage(reason));
    this.name = SKILL_PUBLISH_REFUSAL.errorName;
  }
}
