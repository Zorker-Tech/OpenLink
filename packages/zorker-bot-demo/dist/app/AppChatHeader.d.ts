import { type AppSession } from './data';
export type AppChatHeaderProps = {
    session: AppSession;
    displayName: string;
    assetBase: string;
    computerOpen: boolean;
    showBack: boolean;
    introRunning: boolean;
    onBack: () => void;
    onToggleComputer: () => void;
    onSkipIntro: () => void;
};
export declare function AppChatHeader({ session, displayName, assetBase, computerOpen, showBack, introRunning, onBack, onToggleComputer, onSkipIntro, }: AppChatHeaderProps): import("react").JSX.Element;
//# sourceMappingURL=AppChatHeader.d.ts.map