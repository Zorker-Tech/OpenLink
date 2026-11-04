/**
 * The models the platform offers, and what each of them takes.
 *
 * A model's parameters are not free-form: each one is a switch or a fixed set of options, and the model only exists in the
 * combinations its variants list. So a selection is checked twice — every value against its own parameter, and then the
 * whole selection against the variants — and a selection the model cannot take is refused before it is sent, with a message
 * that says which part to change.
 */
export interface ParameterOption {
  readonly value: string;
  readonly displayName?: string;
}

export interface ModelParameter {
  readonly id: string;
  readonly name?: string;
  readonly type: "boolean" | "enum";
  readonly values: readonly ParameterOption[];
}

/** One parameter's chosen value: what a variant is made of. */
export interface ParameterChoice {
  readonly id: string;
  readonly value: string;
}

export interface CatalogModel {
  readonly id: string;
  readonly displayName?: string;
  readonly aliases: readonly string[];
  readonly params: readonly ModelParameter[];
  readonly variants: readonly (readonly ParameterChoice[])[];
}

/** A model's entry, by its own id or by one of its aliases — a case-insensitive match, and an empty id matches nothing. */
export function findCatalogEntry(catalog: readonly CatalogModel[], modelId: string): CatalogModel | undefined {
  const needle = modelId.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  return catalog.find((entry) => entry.id.toLowerCase() === needle || entry.aliases.some((alias) => alias.toLowerCase() === needle));
}

/** A variant's choices as a lookup, so "does this variant cover that selection" is one comparison per requested value. */
function choicesById(choices: readonly ParameterChoice[]): Map<string, string> {
  return new Map(choices.map((choice) => [choice.id, choice.value]));
}

function variantCovers(variant: readonly ParameterChoice[], requested: readonly (readonly [string, string])[]): boolean {
  const byId = choicesById(variant);
  return requested.every(([id, value]) => byId.get(id) === value);
}

/** The requested parameters that are the ones in the way: dropping one of them leaves a selection some variant still covers. */
function conflictingIds(variants: readonly (readonly ParameterChoice[])[], requested: readonly (readonly [string, string])[]): string[] {
  return requested
    .filter(([dropId]) => variants.some((variant) => variantCovers(variant, requested.filter(([id]) => id !== dropId))))
    .map(([id]) => id);
}

/**
 * Whether the selection is one of the model's variants: nothing to say when the model has no variants, when nothing was
 * selected, or when a variant covers it — and otherwise the message that names the parameters in the way.
 */
export function validateParamCombination(entry: CatalogModel, params: Readonly<Record<string, string>>): string | null {
  if (entry.variants.length === 0) return null;
  const requested = Object.entries(params);
  if (requested.length === 0) return null;
  if (entry.variants.some((variant) => variantCovers(variant, requested))) return null;
  const conflicting = conflictingIds(entry.variants, requested);
  const requestedText = requested.map(([id, value]) => `${id}=${value}`).join(", ");
  const hint = conflicting.length > 1 ? ` These parameters can't be combined on ${entry.id}: ${conflicting.join(", ")}.` : "";
  return (
    `{${requestedText}} is not a supported parameter combination for ${entry.id}.` +
    hint +
    ` Change one of the conflicting parameters and retry (for example, on some models a 1M context can't be combined with the fast tier).`
  );
}

function unknownParameterMessage(entry: CatalogModel, id: string): string {
  const allowedIds = entry.params.map((parameter) => parameter.id).join(", ");
  return `'${id}' is not a parameter of ${entry.id}.` + (allowedIds.length > 0 ? ` Allowed parameters: ${allowedIds}.` : " This model takes no parameters.");
}

function invalidValueMessage(entry: CatalogModel, id: string, value: string, allowed: readonly ParameterOption[]): string {
  return `'${value}' is not a valid value for '${id}' on ${entry.id}. Allowed: ${allowed.map((candidate) => candidate.value).join(", ")}.`;
}

/** Every value checked against its own parameter; the combination is only checked when every value was valid. */
export function validateModelParams(entry: CatalogModel, params: Readonly<Record<string, string>>): string[] {
  const errors: string[] = [];
  for (const [id, value] of Object.entries(params)) {
    const definition = entry.params.find((parameter) => parameter.id === id);
    if (definition == null) {
      errors.push(unknownParameterMessage(entry, id));
      continue;
    }
    if (!definition.values.some((candidate) => candidate.value === value)) errors.push(invalidValueMessage(entry, id, value, definition.values));
  }
  if (errors.length > 0) return errors;
  const combinationError = validateParamCombination(entry, params);
  return combinationError == null ? errors : [...errors, combinationError];
}

/** Every choice the model's variants ever offer, once each: what the incompatibility notes are made of. */
function distinctChoices(variants: readonly (readonly ParameterChoice[])[]): ParameterChoice[] {
  const seen = new Set<string>();
  const choices: ParameterChoice[] = [];
  for (const variant of variants) {
    for (const { id, value } of variant) {
      const key = `${id}=${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      choices.push({ id, value });
    }
  }
  return choices;
}

/** The pairs of choices no variant offers together: what the model can be told it cannot combine. */
export function describeParamIncompatibilities(entry: CatalogModel): string[] {
  if (entry.variants.length === 0) return [];
  const looksUps = entry.variants.map(choicesById);
  const coOccurs = (a: ParameterChoice, b: ParameterChoice): boolean => looksUps.some((byId) => byId.get(a.id) === a.value && byId.get(b.id) === b.value);
  const choices = distinctChoices(entry.variants);
  const notes: string[] = [];
  for (const [index, a] of choices.entries()) {
    for (const b of choices.slice(index + 1)) {
      // Two values of the same parameter never appear together, so they are not an incompatibility to report.
      if (a.id !== b.id && !coOccurs(a, b)) notes.push(`${a.id}=${a.value} cannot be combined with ${b.id}=${b.value}`);
    }
  }
  return notes;
}
