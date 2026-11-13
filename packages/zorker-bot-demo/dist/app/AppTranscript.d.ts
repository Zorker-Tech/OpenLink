import type { ReactNode, Ref } from 'react';
import type { ComputerStatus, PendingBeat, ScriptedScreen, TranscriptEntry } from '../types';
import { type AppSession } from './data';
export type AppTranscriptProps = {
    entries: TranscriptEntry[];
    pending: PendingBeat | null;
    status?: ReactNode;
    screen: ScriptedScreen;
    cardStatus: ComputerStatus;
    assetBase: string;
    session: AppSession;
    displayName: string;
    transcriptRef: Ref<HTMLDivElement>;
    onOpenComputer: () => void;
    onTakeOver: () => void;
    onFinishComputer: () => void;
    onSuggestion: (suggestion: string) => void;
};
export declare function AppTranscript({ entries, pending, status, screen, cardStatus, assetBase, session, displayName, transcriptRef, onOpenComputer, onTakeOver, onFinishComputer, onSuggestion, }: AppTranscriptProps): import("react").JSX.Element;
//# sourceMappingURL=AppTranscript.d.ts.map