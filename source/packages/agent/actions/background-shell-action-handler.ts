/**
 * The action handler for work that happens beside the conversation.
 *
 * An action that is handled outside the turn — a background shell reporting in, a completion arriving —
 * still has to leave the conversation's state consistent, and the state is derived rather than patched.
 * So the handler's whole job is to recompute the structure: there is no model call, no tool call, and
 * nothing for the user to see.
 *
 * The single-step variant exists because some callers ask one step at a time, and it reports the same
 * thing: a new state and no tool call to run.
 */

/** The one thing this handler needs: how to compute the conversation's state from the context. */
interface StateHandler<Context, State> {
  computeNewStructure(ctx: Context): Promise<State> | State;
}

/**
 * A handler for actions that leave nothing to run.
 *
 * The arguments a language-model turn would use are accepted and ignored — the signature is the turn's, and this
 * handler answers with the state it computed and no tool call at all.
 */
export class NoOpSideChannelActionHandler {
  async handle<Context, State>(
    ctx: Context,
    _action: unknown,
    _rootPromptExecutor: unknown,
    stateHandler: StateHandler<Context, State>,
    _mcpTools: unknown,
    _onStateUpdate: unknown,
  ): Promise<State> {
    return stateHandler.computeNewStructure(ctx);
  }

  async handleSingleStep<Context, State>(
    ctx: Context,
    _action: unknown,
    _rootPromptExecutor: unknown,
    stateHandler: StateHandler<Context, State>,
    _mcpTools: unknown,
    _onStateUpdate: unknown,
  ): Promise<{ state: State; hasToolCall: false }> {
    return { state: await stateHandler.computeNewStructure(ctx), hasToolCall: false };
  }
}

/** The same handler, for a shell that ran beside the turn: its report changes the state and nothing else. */
export class BackgroundShellActionHandler extends NoOpSideChannelActionHandler {}
