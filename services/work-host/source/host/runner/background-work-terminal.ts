/** Terminal footer interpretation and text sent to background task owners. */

export const SHELL_REWATCH_POLL_DEFAULT_MS = 10_000;
export const SHELL_REWATCH_MAX_WAIT_MS = 5 * 60 * 60 * 1_000;
export const SHELL_REWATCH_MISSING_FILE_GIVE_UP = 5;

export function shellRewatchPollMs(env: NodeJS.ProcessEnv = process.env): number {
  const candidate = Number.parseInt(env.SLATE_SHELL_REWATCH_POLL_MS?.trim() ?? "", 10);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : SHELL_REWATCH_POLL_DEFAULT_MS;
}

export function parseShellTerminalFooter(content: string): { isComplete: boolean; exitCode?: number; isStreamFailure?: boolean } {
  const footerBlock = /\n---\n([\s\S]*?)\n---\s*$/.exec(content)?.[1];
  if (footerBlock === undefined) return { isComplete: false };

  const exitField = /(?:^|\n)exit_code:\s*([^\n]*)/.exec(footerBlock);
  if (exitField !== null) {
    const raw = (exitField[1] ?? "").trim();
    const numeric = Number(raw);
    return { isComplete: true, ...(raw.length > 0 && Number.isInteger(numeric) ? { exitCode: numeric } : {}) };
  }

  const failedWithEndTime = /(?:^|\n)error:\s*([^\n]*)/.test(footerBlock)
    && /(?:^|\n)ended_at:\s*\S/.test(footerBlock);
  return failedWithEndTime ? { isComplete: true, isStreamFailure: true } : { isComplete: false };
}

export function deriveBackgroundSubagentTitle(prompt: string): string {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (text.length === 0) return "Background task";
  const titleLimit = 80;
  return text.length <= titleLimit ? text : `${text.slice(0, titleLimit - 1)}\u2026`;
}

export function formatSteerPrompt(message: string): string {
  const contextHeader = "[Steering message from the parent agent that dispatched you]";
  const continuation = "Take this into account and continue your task from where you are — do not start over.";
  return [contextHeader, message.trim(), continuation].join("\n\n");
}
