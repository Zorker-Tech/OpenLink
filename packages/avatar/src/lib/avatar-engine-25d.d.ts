import type { AgentAvatarOptions, AvatarPoke } from "./avatar-engine.js";

export interface AgentAvatar25DOptions extends AgentAvatarOptions {
  thickness?: number;
  layers?: number;
  sideShade?: number;
  perspective?: number;
  facetLines?: boolean;
  dragMode?: "rotate" | "move";
  maxPitch?: number;
}

export interface AgentAvatarView {
  yaw?: number;
  pitch?: number;
  roll?: number;
}

export declare class AgentAvatar25DEngine {
  constructor(host: HTMLElement, options?: AgentAvatar25DOptions);
  readonly host: HTMLElement;
  readonly options: AgentAvatar25DOptions;
  update(options?: AgentAvatar25DOptions): void;
  setState(state: string): void;
  setExpression(expression: string): void;
  poke(action?: AvatarPoke, options?: { turns?: number }): void;
  gazeTo(vector: { x: number; y: number }): void;
  resetView(): void;
  setView(view?: AgentAvatarView): void;
  start(): void;
  stop(): void;
  destroy(): void;
  getStaticSvg(size?: number): string;
  getPngDataUrl(size?: number): Promise<string>;
}

export declare const DEFAULTS_25D: AgentAvatar25DOptions;
export declare function projectionFor(
  yaw: number,
  pitch: number,
  roll: number,
): {
  a: number;
  b: number;
  c: number;
  d: number;
  vzx: number;
  vzy: number;
  normalZ: number;
};
export declare function rotatePoint(
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  roll: number,
): { x: number; y: number; z: number };
export declare function shadeColor(color: string, amount: number): string;
