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

/** What a single step answers: the state it arrived at, and that there is nothing to run. */
type SideChannelStepAnswer<State> = { state: State; hasToolCall: false };

/** The state a side-channel action arrives at, computed rather than patched onto the old one. */
function recomputedStructure<Context, State>(
  ctx: Context,
  stateHandler: StateHandler<Context, State>,
): Promise<State> | State {
  return stateHandler.computeNewStructure(ctx);
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
    _turnAction: unknown,
    _rootPromptExecutor: unknown,
    stateHandler: StateHandler<Context, State>,
    _toolInventory: unknown,
    _stateUpdateListener: unknown,
  ): Promise<State> {
    return recomputedStructure(ctx, stateHandler);
  }

  async handleSingleStep<Context, State>(
    ctx: Context,
    _turnAction: unknown,
    _rootPromptExecutor: unknown,
    stateHandler: StateHandler<Context, State>,
    _toolInventory: unknown,
    _stateUpdateListener: unknown,
  ): Promise<SideChannelStepAnswer<State>> {
    return { state: await recomputedStructure(ctx, stateHandler), hasToolCall: false };
  }
}

/** The same handler, for a shell that ran beside the turn: its report changes the state and nothing else. */
export class BackgroundShellActionHandler extends NoOpSideChannelActionHandler {}
