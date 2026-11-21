import type { TranscriptEntry } from '../types';
export type TimelineRow = {
    kind: 'entry' | 'attachments' | 'tools' | 'routines';
    entries: TranscriptEntry[];
    index: number;
    timestamp?: number;
    dayStart?: 'initial' | 'boundary';
    unread: boolean;
};
export declare function createTimelineTimeFormatter(locale: string, day: Intl.DateTimeFormat, now: number): (timestamp: number, dayStart: TimelineRow['dayStart']) => string;
export declare function startsTimeGroup(previous: number | undefined, current: number, day: Intl.DateTimeFormat): boolean;
/** Fold adjacent entries in transport order without hiding their identities. */
export declare function foldTimeline(entries: readonly TranscriptEntry[], day: Intl.DateTimeFormat, unreadAfter?: number): TimelineRow[];
//# sourceMappingURL=timeline-rows.d.ts.map