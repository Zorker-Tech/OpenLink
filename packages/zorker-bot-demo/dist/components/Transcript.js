import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ActivityCard } from './ActivityCard';
import { ComputerCard } from './ComputerCard';
import { MessageBubble } from './MessageBubble';
import { PendingRow } from './PendingRow';
import { SystemEntry } from './SystemEntry';
export function Transcript({ entries, pending, screen, cardStatus, assetBase, transcriptRef, onOpenComputer, onTakeOver, onFinishComputer, }) {
    const firstMessageId = entries.find((entry) => entry.kind === 'agent-message' || entry.kind === 'user-message')?.id;
    return (_jsx("div", { className: "zbd-transcript", ref: transcriptRef, children: _jsxs("div", { className: "zbd-transcript-inner", children: [entries.map((entry) => {
                    if (entry.kind === 'system') {
                        return (_jsx("div", { className: "zbd-entry", children: _jsx(SystemEntry, { assetBase: assetBase, entry: entry }) }, entry.id));
                    }
                    if (entry.kind === 'computer') {
                        return (_jsx("div", { className: "zbd-entry", children: _jsx(ComputerCard, { assetBase: assetBase, entry: entry, onFinish: onFinishComputer, onOpen: onOpenComputer, onTakeOver: onTakeOver, screen: screen, status: cardStatus }) }, entry.id));
                    }
                    if (entry.kind === 'activity') {
                        return (_jsx("div", { className: "zbd-entry", children: _jsx(ActivityCard, { entry: entry }) }, entry.id));
                    }
                    return (_jsx("div", { className: "zbd-entry", children: _jsx(MessageBubble, { assetBase: assetBase, entry: entry, showTimestamp: entry.id === firstMessageId }) }, entry.id));
                }), pending ? (_jsx("div", { className: "zbd-entry", children: _jsx(PendingRow, { assetBase: assetBase, pending: pending }) })) : null] }) }));
}
