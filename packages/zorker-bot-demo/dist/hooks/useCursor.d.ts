import { type RefObject } from 'react';
import type { CursorState } from '../types';
export declare function useCursor(rootRef: RefObject<HTMLElement | null>): {
    cursor: CursorState;
    ripples: {
        id: number;
        x: number;
        y: number;
    }[];
    moveTo: (x: number, y: number, immediate?: boolean) => number;
    showAt: (x: number, y: number) => Promise<void>;
    moveToTarget: (element: Element, xRatio?: number, yRatio?: number) => Promise<void>;
    click: (action: () => void) => Promise<void>;
    hide: () => void;
    reset: () => void;
    waitForTarget: (name: string, timeoutMs?: number) => Promise<HTMLElement>;
};
//# sourceMappingURL=useCursor.d.ts.map