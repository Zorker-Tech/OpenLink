import type { PendingBeat } from '../types';
export type PendingRowProps = {
    pending: PendingBeat;
    assetBase: string;
};
/**
 * The turn is in flight. Show a three-dot beat inside the transcript instead of
 * a static "Working" label. A concrete tool/status label is still shown when the
 * host provides one.
 */
export declare function PendingRow({ pending }: PendingRowProps): import("react").JSX.Element;
//# sourceMappingURL=PendingRow.d.ts.map