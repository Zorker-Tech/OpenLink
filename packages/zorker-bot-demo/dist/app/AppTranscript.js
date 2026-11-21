import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useSyncExternalStore } from 'react';
import { ActivityCard } from '../components/ActivityCard';
import { AgentAvatar } from '../components/AgentAvatar';
import { ComputerCard } from '../components/ComputerCard';
import { ConfirmationCard } from '../components/ConfirmationCard';
import { MessageBubble } from '../components/MessageBubble';
import { PendingRow } from '../components/PendingRow';
import { SystemEntry } from '../components/SystemEntry';
import { formatTranscriptTime, sessionToAgent, } from './data';
const TIMESTAMP_GAP_MS = 15 * 60_000;
const subscribeToTimeZone = () => () => { };
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverTimeZone = () => 'UTC';
function startsTimeGroup(previous, current, day) {
    return previous === undefined || current - previous >= TIMESTAMP_GAP_MS ||
        day.format(previous) !== day.format(current);
}
function sameAuthor(left, right) {
    if (left?.kind === 'user-message' && right?.kind === 'user-message')
        return true;
    if (left?.kind !== 'agent-message' || right?.kind !== 'agent-message')
        return false;
    return (left.author?.id ?? '') === (right.author?.id ?? '');
}
const EMPTY_SUGGESTIONS = [
    'Research my pipeline and draft outreach',
    'Triage my inbox and flag what needs me',
    'Prep me for tomorrow’s meetings',
];
export function AppTranscript({ entries, pending, status, screen, cardStatus, assetBase, session, displayName, locale, replyTargetId, renderMessage, renderMessageMenu, transcriptRef, onScroll, onOpenComputer, onTakeOver, onFinishComputer, onSuggestion, onReact, getReplyAction, }) {
    const agent = sessionToAgent(session, displayName);
    const timeZone = useSyncExternalStore(subscribeToTimeZone, browserTimeZone, serverTimeZone);
    const day = useMemo(() => new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeZone }), [timeZone]);
    const dateTime = useMemo(() => locale && new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        weekday: 'long',
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
    }), [locale, timeZone]);
    let previousTimestamp;
    return (_jsx("div", { className: "zbd-transcript zbd-app-transcript", onScroll: onScroll, ref: transcriptRef, children: _jsxs("div", { className: "zbd-transcript-inner zbd-app-transcript-inner", children: [entries.map((entry, index) => {
                    const timestamp = entry.timestampMs;
                    const showTimestamp = timestamp !== undefined && startsTimeGroup(previousTimestamp, timestamp, day);
                    if (timestamp !== undefined)
                        previousTimestamp = timestamp;
                    const time = showTimestamp ? (_jsx("time", { className: "zbd-time-separator", dateTime: new Date(timestamp).toISOString(), suppressHydrationWarning: true, children: dateTime ? dateTime.format(timestamp) : formatTranscriptTime(timestamp) })) : null;
                    if (entry.kind === 'system') {
                        return (_jsxs("div", { className: "zbd-entry", "data-has-timestamp": showTimestamp ? '' : undefined, children: [time, _jsx(SystemEntry, { assetBase: assetBase, entry: entry })] }, entry.id));
                    }
                    if (entry.kind === 'computer') {
                        return (_jsxs("div", { className: "zbd-entry", "data-has-timestamp": showTimestamp ? '' : undefined, children: [time, _jsx(ComputerCard, { assetBase: assetBase, entry: entry, onFinish: onFinishComputer, onOpen: onOpenComputer, onTakeOver: onTakeOver, screen: screen, status: cardStatus })] }, entry.id));
                    }
                    if (entry.kind === 'activity') {
                        return (_jsxs("div", { className: "zbd-entry", "data-has-timestamp": showTimestamp ? '' : undefined, children: [time, _jsx(ActivityCard, { entry: entry })] }, entry.id));
                    }
                    if (entry.kind === 'confirmation') {
                        return (_jsxs("div", { className: "zbd-entry", "data-has-timestamp": showTimestamp ? '' : undefined, children: [time, _jsx(ConfirmationCard, { entry: entry })] }, entry.id));
                    }
                    const authorLabel = entry.kind === 'agent-message' && session.isGroup
                        ? entry.author?.name
                        : undefined;
                    const previous = entries[index - 1];
                    const next = entries[index + 1];
                    const joinsPrevious = !showTimestamp && sameAuthor(previous, entry);
                    const joinsNext = next?.timestampMs !== undefined &&
                        !startsTimeGroup(entry.timestampMs, next.timestampMs, day) && sameAuthor(entry, next);
                    const groupPosition = joinsPrevious
                        ? joinsNext ? 'middle' : 'end'
                        : joinsNext ? 'start' : 'single';
                    return (_jsxs("div", { className: authorLabel
                            ? 'zbd-entry zbd-app-group-entry'
                            : 'zbd-entry', "data-entry-id": entry.id, "data-reply-target": entry.id === replyTargetId ? '' : undefined, "data-has-timestamp": showTimestamp ? '' : undefined, "data-same-group": joinsPrevious ? '' : undefined, children: [time, authorLabel ? (_jsx("div", { className: "zbd-app-group-author", children: authorLabel })) : null, _jsx(MessageBubble, { assetBase: assetBase, entry: entry, groupPosition: groupPosition, onReact: onReact, onReply: getReplyAction?.(entry), renderContent: renderMessage, renderMenu: renderMessageMenu })] }, entry.id));
                }), pending ? (_jsx("div", { className: "zbd-entry", children: _jsx(PendingRow, { assetBase: assetBase, pending: pending }) })) : null, status ? (_jsx("div", { className: "zbd-entry zbd-app-task-status", children: status })) : null, entries.length === 0 && !pending && !status ? (_jsxs("div", { className: "zbd-app-empty", children: [_jsx("span", { className: "zbd-app-empty-avatar", children: _jsx(AgentAvatar, { agent: agent, assetBase: assetBase, className: session.isDraft ? 'zbd-app-avatar-new' : undefined, size: 52 }) }), _jsx("h2", { children: "What should this agent take off your plate?" }), _jsx("p", { children: "Give it a real outcome. It can work across your tools and come back with something finished." }), _jsx("div", { className: "zbd-app-empty-suggestions", children: EMPTY_SUGGESTIONS.map((suggestion) => (_jsx("button", { className: "zbd-app-empty-suggestion", onClick: () => onSuggestion(suggestion), type: "button", children: suggestion }, suggestion))) })] })) : null] }) }));
}
