import type { Ref } from 'react';
import type { ComputerStatus, PendingBeat, ScriptedScreen, TranscriptEntry } from '../types';
export type TranscriptProps = {
    entries: TranscriptEntry[];
    pending: PendingBeat | null;
    screen: ScriptedScreen;
    cardStatus: ComputerStatus;
    assetBase: string;
    transcriptRef: Ref<HTMLDivElement>;
    onOpenComputer: () => void;
    onTakeOver: () => void;
    onFinishComputer: () => void;
};
export declare function Transcript({ entries, pending, screen, cardStatus, assetBase, transcriptRef, onOpenComputer, onTakeOver, onFinishComputer, }: TranscriptProps): import("react").JSX.Element;
//# sourceMappingURL=Transcript.d.ts.map