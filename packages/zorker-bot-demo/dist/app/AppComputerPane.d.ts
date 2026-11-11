import type { ScriptedScreen } from '../types';
import type { AppSession } from './data';
export type AppComputerPaneProps = {
    session: AppSession;
    displayName: string;
    assetBase: string;
    isSales: boolean;
    screen: ScriptedScreen;
    onClose: () => void;
    onOpenScreen: () => void;
};
export declare function AppComputerPane({ session, displayName, assetBase, isSales, screen, onClose, onOpenScreen, }: AppComputerPaneProps): import("react").JSX.Element;
//# sourceMappingURL=AppComputerPane.d.ts.map