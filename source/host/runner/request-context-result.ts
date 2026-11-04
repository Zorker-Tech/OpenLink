export interface RequestContextProvider {
  resolve(): { osVersion?: string; shell?: string; timeZone?: string; transcriptsFolder?: string; userFullName?: string };
  resolveRules(): Promise<readonly unknown[] | undefined>;
}

interface RequestContextFactories<Result> {
  result(fields: Record<string, unknown>): Result;
  success(fields: Record<string, unknown>): unknown;
  context(fields: Record<string, unknown>): unknown;
  environment(fields: Record<string, unknown>): unknown;
}

/** Assemble the request-context envelope while leaving message construction at the interop boundary. */
export async function createRequestContextResult<Result>(args: {
  readonly source: RequestContextProvider;
  readonly includeTranscripts: boolean;
  readonly autoReviewEnforceEnabled: boolean;
  readonly resolveAgentSkills?: () => readonly unknown[];
  readonly factories: RequestContextFactories<Result>;
}): Promise<Result> {
  const machine = args.source.resolve();
  const rules = await args.source.resolveRules();
  const environment = args.factories.environment({
    osVersion: machine.osVersion!,
    shell: machine.shell!,
    timeZone: machine.timeZone!,
    agentTranscriptsFolder: args.includeTranscripts ? machine.transcriptsFolder! : undefined!,
    smartModeClassifierAutoModeEnabled: args.autoReviewEnforceEnabled,
  });
  const requestContext = args.factories.context({
    env: environment,
    rules: rules ?? [],
    rulesInfoComplete: rules !== undefined,
    agentSkills: args.resolveAgentSkills?.() ?? [],
  });
  return args.factories.result({
    result: { case: "success", value: args.factories.success({ requestContext }) },
  });
}
