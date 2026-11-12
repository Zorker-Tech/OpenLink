import type { TranscriptEntry } from '../types';
export type ConfirmationCardProps = {
    entry: Extract<TranscriptEntry, {
        kind: 'confirmation';
    }>;
};
/**
 * A question the Bot needs answered. It uses the same compact card shell as an
 * activity row so the timeline keeps one rhythm; the answer control stays in
 * the composer dock, where it already lives.
 */
export declare function ConfirmationCard({ entry }: ConfirmationCardProps): import("react").JSX.Element;
//# sourceMappingURL=ConfirmationCard.d.ts.map