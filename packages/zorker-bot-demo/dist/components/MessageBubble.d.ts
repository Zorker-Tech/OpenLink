import type { ReactNode } from 'react';
import type { TranscriptEntry } from '../types';
export type MessageBubbleProps = {
    entry: Extract<TranscriptEntry, {
        kind: 'agent-message' | 'user-message';
    }>;
    assetBase: string;
    showTimestamp?: boolean;
    timestampLabel?: string;
    renderContent?: (content: string) => ReactNode;
};
export declare function MessageBubble({ entry, assetBase, showTimestamp, timestampLabel, renderContent, }: MessageBubbleProps): import("react").JSX.Element;
//# sourceMappingURL=MessageBubble.d.ts.map