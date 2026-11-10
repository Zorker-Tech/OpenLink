/** Convert the former worktree spelling for paths arriving from supported desktop layouts. */

export function adaptLegacyWorktreePath(value: string): string {
  const segments = value.split("/");
  const hasRecognizedRoot = segments[1] === "Users" || segments[1] === "home";
  const hasProfile = segments[2] !== undefined && segments[2].length > 0;

  if (
    segments[0] !== "" ||
    !hasRecognizedRoot ||
    !hasProfile ||
    segments[3] !== ".cursor" ||
    segments[4] !== "worktries"
  ) {
    return value;
  }

  segments[4] = "worktrees";
  return segments.join("/");
}
