/** Active foreground shells addressable by the tool call that started them. */
import type { ShellForegroundRequest } from "./shell-stream-contracts.ts";

export class ShellStreamForegroundRuns {
  private readonly requests = new Map<string, ShellForegroundRequest>();

  register(toolCallId: string, request: ShellForegroundRequest): () => void {
    this.requests.set(toolCallId, request);
    return () => {
      if (this.requests.get(toolCallId) === request) this.requests.delete(toolCallId);
    };
  }

  requestBackground(toolCallId: string): ReturnType<ShellForegroundRequest["requestBackground"]> {
    return this.requests.get(toolCallId)?.requestBackground();
  }
}
