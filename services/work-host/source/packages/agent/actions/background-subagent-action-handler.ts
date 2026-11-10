/**
 * The action handler for a subagent reporting in from beside the conversation.
 *
 * Like a background shell, a subagent's completion arrives as an action rather than as part of a turn,
 * and it changes the conversation's state without the model being asked anything. So it is the same
 * no-op side-channel handler: recompute the structure, run no tool, show the user nothing.
 */

import { NoOpSideChannelActionHandler } from "./background-shell-action-handler.ts"

export class BackgroundSubagentActionHandler extends NoOpSideChannelActionHandler {}
