function errorNode(error: Error, visited: Set<unknown>): string {
  const code = (error as Error & { code?: unknown }).code;
  const codeSuffix = typeof code === "string" && code.length > 0 && !error.message.includes(code) ? ` (${code})` : "";
  let text = `${error.name}: ${error.message}${codeSuffix}`;
  const nestedErrors = (error as Error & { errors?: unknown }).errors;
  if (!Array.isArray(nestedErrors) || nestedErrors.length === 0) return text;

  const children = nestedErrors.filter((item) => !visited.has(item)).map((item) => {
    if (!(item instanceof Error)) return String(item);
    visited.add(item);
    return errorNode(item, visited);
  }).join("; ");
  if (children.length > 0) text += ` [${children}]`;
  return text;
}

export function describeHostBundleErrorDetail(error: unknown, phase?: string): string {
  const chain: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current != null && !visited.has(current)) {
    visited.add(current);
    if (!(current instanceof Error)) {
      chain.push(String(current));
      break;
    }
    chain.push(errorNode(current, visited));
    current = current.cause;
  }
  const description = chain.length > 0 ? chain.join(" → ") : String(error);
  return phase == null ? description : `@phase:${phase} ${description}`;
}
