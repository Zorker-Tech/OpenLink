import type { TranscriptEntry } from '../types';
export type ActivityCardProps = {
    entry: Extract<TranscriptEntry, {
        kind: 'activity';
    }>;
};
export declare function ActivityCard({ entry }: ActivityCardProps): import("react").JSX.Element;
//# sourceMappingURL=ActivityCard.d.ts.map