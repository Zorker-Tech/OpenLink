import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useSyncExternalStore } from 'react';
import { ActivityCard } from '../components/ActivityCard';
import { AgentAvatar } from '../components/AgentAvatar';
import { ComputerCard } from '../components/ComputerCard';
import { ConfirmationCard } from '../components/ConfirmationCard';
import { MessageBubble } from '../components/MessageBubble';
import { PendingRow } from '../components/PendingRow';
import { SystemEntry } from '../components/SystemEntry';
import { createTimelineTimeFormatter, foldTimeline, startsTimeGroup } from './timeline-rows';
import { formatTranscriptTime, sessionToAgent, } from './data';
const subscribeToTimeZone = () => () => { };
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverTimeZone = () => 'UTC';
function sameAuthor(left, right) {
    if (left?.kind === 'user-message' && right?.kind === 'user-message')
        return !left.attachment && !right.attachment && !right.replyTo;
    if (left?.kind !== 'agent-message' || right?.kind !== 'agent-message')
        return false;
    return !left.attachment && !right.attachment && !right.replyTo && (left.author?.id ?? '') === (right.author?.id ?? '');
}
const EMPTY_SUGGESTIONS = [
    'Research my pipeline and draft outreach',
    'Triage my inbox and flag what needs me',
    'Prep me for tomorrow’s meetings',
];
export function AppTranscript({ entries, pending, status, screen, cardStatus, assetBase, session, displayName, locale, replyTargetId, unreadAfter, renderMessage, renderPrompt, renderGroupAuthor, renderGroupAvatar, renderReplyReference, renderMessageActions, renderMessageMenu, transcriptRef, onScroll, onOpenComputer, onTakeOver, onFinishComputer, onSuggestion, onReact, getReplyAction, }) {
    const agent = sessionToAgent(session, displayName);
    const timeZone = useSyncExternalStore(subscribeToTimeZone, browserTimeZone, serverTimeZone);
    const day = useMemo(() => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }), [timeZone]);
    const dateTime = locale && createTimelineTimeFormatter(locale, day, Date.now());
    const rows = useMemo(() => foldTimeline(entries, day, unreadAfter), [entries, day, unreadAfter]);
    const renderEntry = (entry, groupPosition) => {
        switch (entry.kind) {
            case 'system':
                return _jsx(SystemEntry, { assetBase: assetBase, entry: entry });
            case 'computer':
                return _jsx(ComputerCard, { assetBase: assetBase, entry: entry, onFinish: onFinishComputer, onOpen: onOpenComputer, onTakeOver: onTakeOver, screen: screen, status: cardStatus });
            case 'activity':
                return _jsx(ActivityCard, { entry: entry });
            case 'confirmation':
                return _jsx(ConfirmationCard, { entry: entry });
            case 'agent-message':
            case 'user-message': {
                const author = session.isGroup && entry.kind === 'agent-message' ? entry.author : undefined;
                const message = (_jsxs(_Fragment, { children: [entry.replyTo && renderReplyReference ? _jsx("div", { className: "zbd-app-message-reference", "data-side": entry.kind === 'user-message' ? 'user' : 'agent', children: renderReplyReference(entry) }) : null, _jsx(MessageBubble, { assetBase: assetBase, entry: entry, groupPosition: groupPosition, onReact: onReact, onReply: getReplyAction?.(entry), renderActions: renderMessageActions, renderContent: renderMessage, renderUserContent: renderPrompt, renderMenu: renderMessageMenu })] }));
                if (!author?.name)
                    return message;
                const startsRun = groupPosition === 'single' || groupPosition === 'start';
                const endsRun = groupPosition === 'single' || groupPosition === 'end';
                return (_jsxs("div", { className: "zbd-app-author-run", children: [_jsx("div", { className: "zbd-app-author-gutter", children: endsRun ? renderGroupAvatar?.(author) ?? _jsx("span", { "aria-hidden": "true", className: "zbd-app-author-fallback", children: Array.from(author.name)[0] }) : null }), _jsxs("div", { className: "zbd-app-author-messages", children: [startsRun ? _jsx("div", { className: "zbd-app-group-author", children: renderGroupAuthor?.(author) ?? author.name }) : null, message] })] }));
            }
        }
    };
    return (_jsx("div", { className: "zbd-transcript zbd-app-transcript", onScroll: onScroll, ref: transcriptRef, children: _jsxs("div", { className: "zbd-transcript-inner zbd-app-transcript-inner", children: [rows.map(({ dayStart, entries: grouped, index, kind, timestamp, unread }) => {
                    const entry = grouped[0];
                    const time = timestamp !== undefined ? (_jsx("time", { className: "zbd-time-separator", dateTime: new Date(timestamp).toISOString(), suppressHydrationWarning: true, children: dateTime ? dateTime(timestamp, dayStart) : formatTranscriptTime(timestamp) })) : null;
                    const previous = entries[index - 1];
                    const next = entries[index + 1];
                    const joinsPrevious = timestamp === undefined && !unread && sameAuthor(previous, entry);
                    const joinsNext = entry.timestampMs !== undefined && next?.timestampMs !== undefined &&
                        !(unreadAfter !== undefined && entry.timestampMs <= unreadAfter && next.timestampMs > unreadAfter) &&
                        !startsTimeGroup(entry.timestampMs, next.timestampMs, day) && sameAuthor(entry, next);
                    const groupPosition = joinsPrevious
                        ? joinsNext ? 'middle' : 'end'
                        : joinsNext ? 'start' : 'single';
                    const divider = unread ? _jsx("div", { className: "zbd-timeline-unread", role: "separator", "aria-label": "Unread messages", children: "Unread messages" }) : null;
                    const renderGroupedEntries = () => grouped.map((member, offset) => (_jsx("div", { "data-entry-id": member.id, "data-reply-target": member.id === replyTargetId ? '' : undefined, children: renderEntry(member, offset === 0 ? 'start' : offset === grouped.length - 1 ? 'end' : 'middle') }, member.id)));
                    const visible = kind === 'tools' ? (_jsxs("details", { className: "zbd-tool-run", children: [_jsx("summary", { children: grouped.length === 1 ? 'Tool activity' : `${grouped.length} tool steps` }), _jsx("div", { className: "zbd-timeline-group", children: renderGroupedEntries() })] })) : grouped.length > 1 ? (_jsx("div", { className: "zbd-timeline-group", role: "group", "aria-label": kind === 'attachments' ? 'Attachments' : 'Routine updates', children: renderGroupedEntries() })) : renderEntry(entry, groupPosition);
                    return (_jsxs("div", { className: session.isGroup && entry.kind === 'agent-message' && entry.author?.name ? 'zbd-entry zbd-app-group-entry' : 'zbd-entry', "data-entry-id": grouped.length === 1 && kind !== 'tools' ? entry.id : undefined, "data-reply-target": grouped.length === 1 && entry.id === replyTargetId ? '' : undefined, "data-has-timestamp": timestamp !== undefined ? '' : undefined, "data-same-group": joinsPrevious ? '' : undefined, children: [time, divider, visible] }, entry.id));
                }), pending ? (_jsx("div", { className: "zbd-entry", children: _jsx(PendingRow, { assetBase: assetBase, pending: pending }) })) : null, status ? (_jsx("div", { className: "zbd-entry zbd-app-task-status", children: status })) : null, entries.length === 0 && !pending && !status ? (_jsxs("div", { className: "zbd-app-empty", children: [_jsx("span", { className: "zbd-app-empty-avatar", children: _jsx(AgentAvatar, { agent: agent, assetBase: assetBase, className: session.isDraft ? 'zbd-app-avatar-new' : undefined, size: 52 }) }), _jsx("h2", { children: "What should this agent take off your plate?" }), _jsx("p", { children: "Give it a real outcome. It can work across your tools and come back with something finished." }), _jsx("div", { className: "zbd-app-empty-suggestions", children: EMPTY_SUGGESTIONS.map((suggestion) => (_jsx("button", { className: "zbd-app-empty-suggestion", onClick: () => onSuggestion(suggestion), type: "button", children: suggestion }, suggestion))) })] })) : null] }) }));
}
