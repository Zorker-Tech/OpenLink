import { type ReactElement, type ReactNode } from 'react';
import type { TranscriptEntry } from '../types';
type MessageEntry = Extract<TranscriptEntry, {
    kind: 'agent-message' | 'user-message';
}>;
export type MessageMenuActions = {
    entry: MessageEntry;
    copy: (content?: string) => void;
    react?: (emoji: string) => void;
    reply?: () => void;
    openEmojiPicker: () => void;
};
export type MessageToolbarActions = Omit<MessageMenuActions, 'openEmojiPicker'> & {
    copied: boolean;
    pickerOpen: boolean;
    toggleEmojiPicker: (anchor: HTMLElement) => void;
};
export type MessageBubbleProps = {
    entry: MessageEntry;
    assetBase: string;
    showTimestamp?: boolean;
    timestampLabel?: string;
    renderContent?: (content: string) => ReactNode;
    renderUserContent?: (content: string) => ReactNode;
    /** Where this message sits in a consecutive run by the same author. */
    groupPosition?: 'single' | 'start' | 'middle' | 'end';
    /** Toggle a reaction on this message. Omit to keep the transcript read-only. */
    onReact?: (entry: MessageEntry, emoji: string) => void;
    onReply?: () => void;
    renderActions?: (actions: MessageToolbarActions) => ReactNode;
    renderMenu?: (bubble: ReactElement, actions: MessageMenuActions) => ReactNode;
};
export declare function MessageBubble({ entry, assetBase, showTimestamp, timestampLabel, renderContent, renderUserContent, groupPosition, onReact, onReply, renderActions, renderMenu, }: MessageBubbleProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=MessageBubble.d.ts.map