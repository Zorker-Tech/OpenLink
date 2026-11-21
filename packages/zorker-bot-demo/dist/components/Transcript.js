import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ActivityCard } from './ActivityCard';
import { ComputerCard } from './ComputerCard';
import { ConfirmationCard } from './ConfirmationCard';
import { MessageBubble } from './MessageBubble';
import { PendingRow } from './PendingRow';
import { SystemEntry } from './SystemEntry';
export function Transcript({ entries, pending, screen, cardStatus, assetBase, transcriptRef, onOpenComputer, onTakeOver, onFinishComputer, onReact, }) {
    const firstMessageId = entries.find((entry) => entry.kind === 'agent-message' || entry.kind === 'user-message')?.id;
    return (_jsx("div", { className: "zbd-transcript", ref: transcriptRef, children: _jsxs("div", { className: "zbd-transcript-inner", children: [entries.map((entry, index) => {
                    if (entry.kind === 'system') {
                        return (_jsx("div", { className: "zbd-entry", children: _jsx(SystemEntry, { assetBase: assetBase, entry: entry }) }, entry.id));
                    }
                    if (entry.kind === 'computer') {
                        return (_jsx("div", { className: "zbd-entry", children: _jsx(ComputerCard, { assetBase: assetBase, entry: entry, onFinish: onFinishComputer, onOpen: onOpenComputer, onTakeOver: onTakeOver, screen: screen, status: cardStatus }) }, entry.id));
                    }
                    if (entry.kind === 'activity') {
                        return (_jsx("div", { className: "zbd-entry", children: _jsx(ActivityCard, { entry: entry }) }, entry.id));
                    }
                    if (entry.kind === 'confirmation') {
                        return (_jsx("div", { className: "zbd-entry", children: _jsx(ConfirmationCard, { entry: entry }) }, entry.id));
                    }
                    const previous = entries[index - 1];
                    const next = entries[index + 1];
                    const sameAuthor = (left, right) => {
                        if (left?.kind === 'user-message' && right?.kind === 'user-message')
                            return true;
                        if (left?.kind !== 'agent-message' || right?.kind !== 'agent-message')
                            return false;
                        return (left.author?.id ?? '') === (right.author?.id ?? '');
                    };
                    const joinsPrevious = sameAuthor(previous, entry);
                    const joinsNext = sameAuthor(entry, next);
                    const groupPosition = joinsPrevious
                        ? joinsNext ? 'middle' : 'end'
                        : joinsNext ? 'start' : 'single';
                    return (_jsx("div", { className: "zbd-entry", "data-same-group": joinsPrevious ? '' : undefined, children: _jsx(MessageBubble, { assetBase: assetBase, entry: entry, groupPosition: groupPosition, onReact: onReact, showTimestamp: entry.id === firstMessageId }) }, entry.id));
                }), pending ? (_jsx("div", { className: "zbd-entry", children: _jsx(PendingRow, { assetBase: assetBase, pending: pending }) })) : null] }) }));
}
