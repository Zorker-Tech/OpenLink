/**
 * The rules an organization sets for its members.
 *
 * A team's rules are fetched from wherever the organization keeps them, and the answer says which of the three things
 * happened: there are rules, there is no team to have rules, or the answer was not complete enough to say — which is
 * different from having none, since an incomplete answer is not an empty one.
 */
export type RulesAnswer<T> =
  | { readonly outcome: "rules"; readonly rules: readonly T[] }
  | { readonly outcome: "no_team" }
  | { readonly outcome: "incomplete" };

export interface TeamRulesResolver<T> {
  start(): void;
  refresh(): void;
  resolveRules(): Promise<readonly T[] | undefined>;
}

/** What a load answer means for what is known: rules replace it, no team empties it, and an incomplete answer leaves it. */
type TeamRulesSnapshot<T> = readonly T[] | undefined;

/** The three things an answer can say, as the resolver applies it. */
export function createTeamRulesResolverFromLoad<T>(options: {
  readonly load: () => Promise<RulesAnswer<T>>;
  readonly reportLoadFailure: (error: unknown) => void;
}): TeamRulesResolver<T> {
  let snapshot: TeamRulesSnapshot<T>;
  let inFlight: Promise<void> | undefined;

  /** What an answer says about the rules, applied to what is already known. */
  const remember = (result: RulesAnswer<T>): void => {
    if (result.outcome === "rules") {
      snapshot = result.rules;
      return;
    }
    // A team that has no rules is a team with no rules; an answer that could not be read says nothing about them.
    if (result.outcome === "no_team") snapshot = [];
  };

  /** One load, reporting a failure rather than throwing it: a caller asking for rules is not the one to fail. */
  const loadOnce = async (): Promise<void> => {
    let result: RulesAnswer<T>;
    try {
      result = await options.load();
    } catch (error) {
      options.reportLoadFailure(error);
      return;
    }
    remember(result);
  };

  /** The load that is running, started if there is none: two callers asking at once share one answer. */
  const loadIfNeeded = (): Promise<void> => {
    if (inFlight === undefined) {
      inFlight = loadOnce().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };

  /** Waits for a load that is already running, so a refresh cannot overlap the load it replaces. */
  const settleRunningLoad = async (): Promise<void> => {
    if (inFlight !== undefined) await inFlight;
  };

  return {
    start() {
      void loadIfNeeded();
    },
    refresh() {
      void (async () => {
        await settleRunningLoad();
        await loadIfNeeded();
      })();
    },
    async resolveRules() {
      if (snapshot !== undefined) return snapshot;
      await loadIfNeeded();
      return snapshot;
    },
  };
}
