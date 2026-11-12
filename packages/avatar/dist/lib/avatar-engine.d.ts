export type AvatarTheme = "dark" | "light" | "auto";
export type AvatarPoke = "spin" | "bounce" | "nod" | "random";

export interface AgentAvatarOptions {
  renderer?: "3d" | "25d" | "complete" | "svg";
  shape?: string;
  color?: string;
  theme?: AvatarTheme;
  state?: string;
  expression?: string;
  size?: number | string;
  followPointer?: boolean;
  hoverTilt?: boolean;
  gazeStrength?: number;
  interactive?: boolean;
  draggable?: boolean;
  clickAction?: AvatarPoke;
  depth?: number;
  glow?: number;
  ring?: boolean;
  shadow?: boolean;
  effects?: boolean;
  autoBlink?: boolean;
  idleMotion?: boolean;
  speed?: number;
  intensity?: number;
  thickness?: number;
  dragMode?: "rotate" | "move";
  layers?: number;
  sideShade?: number;
  perspective?: number;
  facetLines?: boolean;
  maxPitch?: number;
  paused?: boolean;
  reducedMotion?: boolean;
  autoAdvance?: boolean;
  eyeColor?: string | null;
  eyeY?: number | null;
  ariaLabel?: string;
  onPoke?: (action: AvatarPoke) => void;
  onStateChange?: (state: string) => void;
}

export interface ShapeDefinition {
  id: string;
  label: string;
  en: string;
  family: string;
}

export interface ColorDefinition {
  id: string;
  label: string;
  light: string;
  dark: string;
  swatch: string;
}

export interface StateDefinition {
  id: string;
  label: string;
  group: string;
  groupEn: string;
}

export declare class AgentAvatarEngine {
  constructor(host: HTMLElement, options?: AgentAvatarOptions);
  readonly host: HTMLElement;
  readonly options: AgentAvatarOptions;
  update(options?: AgentAvatarOptions): void;
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

export declare const COLORS: ColorDefinition[];
export declare const SHAPES: ShapeDefinition[];
export declare const STATES: StateDefinition[];
export declare const STATE_GROUPS: Array<{
  label: string;
  en: string;
  states: Array<[string, string]>;
}>;
export declare const EXPRESSIONS: Record<string, unknown>;
export declare const STATE_EXPRESSION: Record<string, string>;
export declare const STATE_EFFECTS: Record<string, string[]>;
export declare const AUTO_NEXT: Record<string, { next: string; holdSeconds: number }>;
export declare const DEFAULTS: AgentAvatarOptions;
export declare function getShape(id: string): {
  id: string;
  path: string;
  points: Array<[number, number]>;
  top: number;
  bottom: number;
  spanAt: (y: number) => number;
};
export declare function hashColor(seed: string | number): string;
export declare function hashShape(seed: string | number, compact?: boolean): string;
export declare function resolveColor(color: string, theme: "dark" | "light"): string;
export declare function resolveInk(color: string): string;
export declare function resolveTheme(theme: AvatarTheme): "dark" | "light";
