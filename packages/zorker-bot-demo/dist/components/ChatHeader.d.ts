import type { Agent } from '../types';
export type ChatHeaderProps = {
    agent: Agent;
    assetBase: string;
    computerOpen: boolean;
    onToggleComputer: () => void;
};
export declare function ChatHeader({ agent, assetBase, computerOpen, onToggleComputer, }: ChatHeaderProps): import("react").JSX.Element;
//# sourceMappingURL=ChatHeader.d.ts.map