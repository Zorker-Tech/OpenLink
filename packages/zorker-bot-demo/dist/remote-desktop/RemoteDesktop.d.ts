import type { ScreenView } from '../types';
export type RemoteDesktopProps = {
    assetBase: string;
    view: ScreenView;
    emailChars?: number;
    passwordChars?: number;
    focus?: 'email' | 'password' | null;
    showDock?: boolean;
    agentCursor?: boolean;
    className?: string;
};
export declare function RemoteDesktop({ assetBase, view, emailChars, passwordChars, focus, showDock, agentCursor, className, }: RemoteDesktopProps): import("react").JSX.Element;
//# sourceMappingURL=RemoteDesktop.d.ts.map