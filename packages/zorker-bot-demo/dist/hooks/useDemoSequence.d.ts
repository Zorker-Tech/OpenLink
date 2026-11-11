import { type RefObject } from 'react';
import type { ComputerStatus, PendingBeat, ScreenOverlayState, ScriptedScreen, TranscriptEntry } from '../types';
export declare function useDemoSequence(rootRef: RefObject<HTMLElement | null>): {
    agentName: string;
    agentPreview: string;
    agentTime: string;
    activeAgent: import("..").Agent;
    transcript: TranscriptEntry[];
    pending: PendingBeat | null;
    screen: ScriptedScreen;
    overlay: ScreenOverlayState | null;
    cardStatus: ComputerStatus;
    sidePaneOpen: boolean;
    cursor: import("..").CursorState;
    ripples: {
        id: number;
        x: number;
        y: number;
    }[];
    start: () => Promise<void>;
    applyEndState: () => void;
    finishTakeOver: () => void;
    takeOver: () => void;
    openScreen: (origin?: 'entry' | 'pane') => void;
    closeScreen: () => void;
    toggleComputer: () => void;
    closeComputer: () => void;
    cancel: () => void;
};
//# sourceMappingURL=useDemoSequence.d.ts.map