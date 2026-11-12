import type { AgentAvatarOptions, AvatarPoke } from "./avatar-engine.js";

export interface AgentAvatarCompleteOptions extends AgentAvatarOptions {}

export declare class AgentAvatarCompleteEngine {
  constructor(host: HTMLElement, options?: AgentAvatarCompleteOptions);
  readonly host: HTMLElement;
  readonly options: AgentAvatarCompleteOptions;
  update(options?: AgentAvatarCompleteOptions): void;
  setState(state: string): void;
  setExpression(expression: string): void;
  poke(action?: AvatarPoke, options?: { turns?: number }): void;
  gazeTo(vector: { x: number; y: number }): void;
  start(): void;
  stop(): void;
  destroy(): void;
  getStaticSvg(size?: number): string;
  getPngDataUrl(size?: number): Promise<string>;
}

export declare const DEFAULTS_COMPLETE: AgentAvatarCompleteOptions;
export declare const BODY_NAMES: Record<string, string>;
