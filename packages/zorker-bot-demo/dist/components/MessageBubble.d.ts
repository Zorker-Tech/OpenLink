import type { TranscriptEntry } from '../types';
export type MessageBubbleProps = {
    entry: Extract<TranscriptEntry, {
        kind: 'agent-message' | 'user-message';
    }>;
    assetBase: string;
    showTimestamp?: boolean;
    timestampLabel?: string;
};
export declare function MessageBubble({ entry, assetBase, showTimestamp, timestampLabel, }: MessageBubbleProps): import("react").JSX.Element;
//# sourceMappingURL=MessageBubble.d.ts.map