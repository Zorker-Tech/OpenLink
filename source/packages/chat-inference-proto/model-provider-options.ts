/**
 * The model a request was made for, as the provider's own options carry it.
 *
 * The provider namespace is the one the backend defines, and what is read from it is only accepted when it is a string
 * that says something, so a request with no model named is one with no name rather than an empty one.
 */
export function getProviderModelName(part: { providerOptions?: { cursor?: { modelName?: unknown } } }): string | undefined {
  const modelName = part.providerOptions?.cursor?.modelName;
  return typeof modelName === "string" ? modelName : undefined;
}

export function providerOptionsFromModelName(modelName: string | undefined): Record<string, unknown> {
  return modelName === undefined ? {} : { providerOptions: { cursor: { modelName } } };
}
