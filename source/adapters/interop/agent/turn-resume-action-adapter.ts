/** Builds the counterpart conversation action used when a host turn resumes from a checkpoint. */

import { ConversationAction, ResumeAction } from "../proto/generated/agent/v1/agent_pb.ts"

export const RESUME_TURN_ACTION = new ConversationAction({ action: { case: "resumeAction", value: new ResumeAction() } })
