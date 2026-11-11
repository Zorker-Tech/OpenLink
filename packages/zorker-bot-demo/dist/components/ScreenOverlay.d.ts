import type { ScriptedScreen, ScreenOverlayState } from '../types';
export type ScreenOverlayProps = {
    overlay: ScreenOverlayState;
    screen: ScriptedScreen;
    rootWidth: number;
    rootHeight: number;
    assetBase: string;
    onClose: () => void;
    onFinish: () => void;
};
export declare function ScreenOverlay({ overlay, screen, rootWidth, rootHeight, assetBase, onClose, onFinish, }: ScreenOverlayProps): import("react").JSX.Element;
//# sourceMappingURL=ScreenOverlay.d.ts.map