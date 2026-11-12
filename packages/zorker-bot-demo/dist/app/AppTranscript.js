import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ActivityCard } from '../components/ActivityCard';
import { AgentAvatar } from '../components/AgentAvatar';
import { ComputerCard } from '../components/ComputerCard';
import { ConfirmationCard } from '../components/ConfirmationCard';
import { MessageBubble } from '../components/MessageBubble';
import { PendingRow } from '../components/PendingRow';
import { SystemEntry } from '../components/SystemEntry';
import { formatTranscriptTime, sessionToAgent, } from './data';
const TIMESTAMP_GAP_MS = 60_000;
const EMPTY_SUGGESTIONS = [
    'Research my pipeline and draft outreach',
    'Triage my inbox and flag what needs me',
    'Prep me for tomorrow’s meetings',
];
export function AppTranscript({ entries, pending, screen, cardStatus, assetBase, session, displayName, transcriptRef, onOpenComputer, onTakeOver, onFinishComputer, onSuggestion, }) {
    const agent = sessionToAgent(session, displayName);
    let previousTimestamp = null;
    return (_jsx("div", { className: "zbd-transcript zbd-app-transcript", ref: transcriptRef, children: _jsxs("div", { className: "zbd-transcript-inner zbd-app-transcript-inner", children: [entries.map((entry) => {
                    if (entry.kind === 'system') {
                        const showTimestamp = previousTimestamp === null ||
                            entry.timestampMs - previousTimestamp >= TIMESTAMP_GAP_MS;
                        previousTimestamp = entry.timestampMs;
                        return (_jsxs("div", { className: "zbd-entry", children: [showTimestamp ? (_jsx("div", { className: "zbd-time-separator", suppressHydrationWarning: true, children: formatTranscriptTime(entry.timestampMs) })) : null, _jsx(SystemEntry, { assetBase: assetBase, entry: entry })] }, entry.id));
                    }
                    if (entry.kind === 'computer') {
                        if (entry.timestampMs !== undefined) {
                            previousTimestamp = entry.timestampMs;
                        }
                        return (_jsx("div", { className: "zbd-entry", children: _jsx(ComputerCard, { assetBase: assetBase, entry: entry, onFinish: onFinishComputer, onOpen: onOpenComputer, onTakeOver: onTakeOver, screen: screen, status: cardStatus }) }, entry.id));
                    }
                    if (entry.kind === 'activity') {
                        previousTimestamp = entry.timestampMs;
                        return (_jsx("div", { className: "zbd-entry", children: _jsx(ActivityCard, { entry: entry }) }, entry.id));
                    }
                    if (entry.kind === 'confirmation') {
                        previousTimestamp = entry.timestampMs;
                        return (_jsx("div", { className: "zbd-entry", children: _jsx(ConfirmationCard, { entry: entry }) }, entry.id));
                    }
                    const showTimestamp = previousTimestamp === null ||
                        entry.timestampMs - previousTimestamp >= TIMESTAMP_GAP_MS;
                    previousTimestamp = entry.timestampMs;
                    const authorLabel = entry.kind === 'agent-message' && session.isGroup
                        ? entry.author?.name
                        : undefined;
                    return (_jsxs("div", { className: authorLabel
                            ? 'zbd-entry zbd-app-group-entry'
                            : 'zbd-entry', children: [authorLabel ? (_jsx("div", { className: "zbd-app-group-author", children: authorLabel })) : null, _jsx(MessageBubble, { assetBase: assetBase, entry: entry, showTimestamp: showTimestamp, timestampLabel: showTimestamp
                                    ? formatTranscriptTime(entry.timestampMs)
                                    : undefined })] }, entry.id));
                }), pending ? (_jsx("div", { className: "zbd-entry", children: _jsx(PendingRow, { assetBase: assetBase, pending: pending }) })) : null, entries.length === 0 && !pending ? (_jsxs("div", { className: "zbd-app-empty", children: [_jsx("span", { className: "zbd-app-empty-avatar", children: _jsx(AgentAvatar, { agent: agent, assetBase: assetBase, className: session.isDraft ? 'zbd-app-avatar-new' : undefined, size: 52 }) }), _jsx("h2", { children: "What should this agent take off your plate?" }), _jsx("p", { children: "Give it a real outcome. It can work across your tools and come back with something finished." }), _jsx("div", { className: "zbd-app-empty-suggestions", children: EMPTY_SUGGESTIONS.map((suggestion) => (_jsx("button", { className: "zbd-app-empty-suggestion", onClick: () => onSuggestion(suggestion), type: "button", children: suggestion }, suggestion))) })] })) : null] }) }));
}
