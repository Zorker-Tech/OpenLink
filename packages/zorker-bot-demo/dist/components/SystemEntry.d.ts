import type { TranscriptEntry } from '../types';
export type SystemEntryProps = {
    entry: Extract<TranscriptEntry, {
        kind: 'system';
    }>;
    assetBase: string;
};
export declare function SystemEntry({ entry, assetBase }: SystemEntryProps): import("react").JSX.Element;
//# sourceMappingURL=SystemEntry.d.ts.map