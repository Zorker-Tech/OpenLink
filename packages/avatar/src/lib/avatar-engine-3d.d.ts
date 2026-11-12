import type { AgentAvatarOptions, AvatarPoke } from "./avatar-engine.js";

export interface AgentAvatar3DOptions extends AgentAvatarOptions {
  dragMode?: "rotate" | "move";
}

export declare class AgentAvatar3DEngine {
  constructor(host: HTMLElement, options?: AgentAvatar3DOptions);
  readonly host: HTMLElement;
  readonly options: AgentAvatar3DOptions;
  update(options?: AgentAvatar3DOptions): void;
  setState(state: string): void;
  setExpression(expression: string): void;
  poke(action?: AvatarPoke, options?: { turns?: number }): void;
  gazeTo(vector: { x: number; y: number }): void;
  resetView(): void;
  setView(view?: { yaw?: number; pitch?: number; roll?: number }): void;
  start(): void;
  stop(): void;
  destroy(): void;
  getStaticSvg(size?: number): string;
  getPngDataUrl(size?: number): Promise<string>;
}

export declare const DEFAULTS_3D: AgentAvatar3DOptions;
export declare const BODY_NAMES: Record<string, string>;
