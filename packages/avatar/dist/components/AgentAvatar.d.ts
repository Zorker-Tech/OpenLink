import { type CSSProperties } from "react";
import { AgentAvatarEngine } from "../lib/avatar-engine.js";
import type { AgentAvatarOptions, AvatarPoke } from "../lib/avatar-engine.js";
import type { AgentAvatar3DEngine as AgentAvatar3DEngineType } from "../lib/avatar-engine-3d.js";
import type { AgentAvatarCompleteEngine as AgentAvatarCompleteEngineType } from "../lib/avatar-engine-complete.js";
import type { AgentAvatar25DEngine as AgentAvatar25DEngineType } from "../lib/avatar-engine-25d.js";
import "./AgentAvatar.css";
type ActiveEngine = AgentAvatarEngine | AgentAvatar3DEngineType | AgentAvatarCompleteEngineType | AgentAvatar25DEngineType;
export interface AgentAvatarHandle {
    poke: (action?: AvatarPoke, options?: {
        turns?: number;
    }) => void;
    setState: (state: string) => void;
    setExpression: (expression: string) => void;
    gazeTo: (vector: {
        x: number;
        y: number;
    }) => void;
    resetView: () => void;
    setView: (view: {
        yaw?: number;
        pitch?: number;
        roll?: number;
    }) => void;
    getStaticSvg: (size?: number) => string;
    getPngDataUrl: (size?: number) => Promise<string>;
    getEngine: () => ActiveEngine | null;
}
export interface AgentAvatarProps extends AgentAvatarOptions {
    className?: string;
    style?: CSSProperties;
}
export declare const AgentAvatar: import("react").ForwardRefExoticComponent<AgentAvatarProps & import("react").RefAttributes<AgentAvatarHandle>>;
export {};
//# sourceMappingURL=AgentAvatar.d.ts.map