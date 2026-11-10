export function quoteInlineYamlScalar(value: string): string {
  const needsQuotes = /[\n\r:#[\]{}&*!|>'"%@`]/.test(value) || value.startsWith(" ") || value.endsWith(" ");
  if (!needsQuotes) return value;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
