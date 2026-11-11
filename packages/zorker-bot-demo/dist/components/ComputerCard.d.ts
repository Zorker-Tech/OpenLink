import type { ComputerStatus, ScriptedScreen, TranscriptEntry } from '../types';
export type ComputerCardProps = {
    entry: Extract<TranscriptEntry, {
        kind: 'computer';
    }>;
    status: ComputerStatus;
    screen: ScriptedScreen;
    assetBase: string;
    onOpen: () => void;
    onTakeOver: () => void;
    onFinish: () => void;
};
export declare function ComputerCard({ entry, status, screen, assetBase, onOpen, onTakeOver, onFinish, }: ComputerCardProps): import("react").JSX.Element;
//# sourceMappingURL=ComputerCard.d.ts.map