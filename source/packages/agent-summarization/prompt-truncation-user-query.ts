const USER_QUERY_BLOCK = /<user_query>[\s\S]*?<\/user_query>/g;

/** Keep the user's tagged text intact while trimming the surrounding assistant material first. */
export function truncateWithUserQuery(entry: string, maxChars: number): string {
  const blocks = [...entry.matchAll(USER_QUERY_BLOCK)].map((match) => match[0]);
  if (blocks.length === 0) return entry.slice(0, maxChars);

  const retainedQuery = blocks.join("\n");
  if (retainedQuery.length >= maxChars) return retainedQuery.slice(0, maxChars);
  const surrounding = entry.replace(USER_QUERY_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
  if (surrounding.length === 0) return retainedQuery;

  const available = maxChars - retainedQuery.length - 1;
  if (available <= 0) return retainedQuery;
  return `${surrounding.slice(0, available)}\n${retainedQuery}`;
}
