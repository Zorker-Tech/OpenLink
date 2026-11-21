import { type ReactNode, type Ref, type UIEventHandler } from 'react';
import type { ComputerStatus, PendingBeat, ScriptedScreen, TranscriptEntry } from '../types';
import { type MessageBubbleProps } from '../components/MessageBubble';
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
    locale?: string;
    replyTargetId?: string;
    renderMessage?: (content: string) => ReactNode;
    renderMessageMenu?: MessageBubbleProps['renderMenu'];
    transcriptRef: Ref<HTMLDivElement>;
    onScroll?: UIEventHandler<HTMLDivElement>;
    onOpenComputer: () => void;
    onTakeOver: () => void;
    onFinishComputer: () => void;
    onSuggestion: (suggestion: string) => void;
    onReact?: (entry: Extract<TranscriptEntry, {
        kind: 'agent-message' | 'user-message';
    }>, emoji: string) => void;
    getReplyAction?: (entry: Extract<TranscriptEntry, {
        kind: 'agent-message' | 'user-message';
    }>) => (() => void) | undefined;
};
export declare function AppTranscript({ entries, pending, status, screen, cardStatus, assetBase, session, displayName, locale, replyTargetId, renderMessage, renderMessageMenu, transcriptRef, onScroll, onOpenComputer, onTakeOver, onFinishComputer, onSuggestion, onReact, getReplyAction, }: AppTranscriptProps): import("react").JSX.Element;
//# sourceMappingURL=AppTranscript.d.ts.map