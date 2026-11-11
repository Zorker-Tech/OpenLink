import type { Ref } from 'react';
import type { ScriptedScreen } from '../types';
export type ScreenFrameProps = {
    assetBase: string;
    screen: ScriptedScreen;
    height: number;
    className?: string;
    frameRef?: Ref<HTMLDivElement>;
};
export declare function ScreenFrame({ assetBase, screen, height, className, frameRef, }: ScreenFrameProps): import("react").JSX.Element;
//# sourceMappingURL=ScreenFrame.d.ts.map