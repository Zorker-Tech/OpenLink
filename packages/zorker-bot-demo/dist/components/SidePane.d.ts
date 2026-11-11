import type { ScriptedScreen } from '../types';
export type SidePaneProps = {
    assetBase: string;
    screen: ScriptedScreen;
    onClose: () => void;
    onOpenScreen: () => void;
};
export declare function SidePane({ assetBase, screen, onClose, onOpenScreen, }: SidePaneProps): import("react").JSX.Element;
//# sourceMappingURL=SidePane.d.ts.map