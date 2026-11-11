import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { reactionMask } from '../lib/reaction-mask';
import { formatTime } from '../lib/format-time';
import { RichText } from './RichText';
export function MessageBubble({ entry, assetBase, showTimestamp = false, timestampLabel, }) {
    var _a;
    const isUser = entry.kind === 'user-message';
    const reactions = (_a = entry.reactions) !== null && _a !== void 0 ? _a : [];
    const mask = reactions.length > 0
        ? reactionMask(reactions.length, isUser ? 'user' : 'agent')
        : undefined;
    return (_jsxs(_Fragment, { children: [showTimestamp ? (_jsx("div", { className: "zbd-time-separator", suppressHydrationWarning: true, children: timestampLabel !== null && timestampLabel !== void 0 ? timestampLabel : formatTime(entry.timestampMs) })) : null, _jsx("div", { className: isUser ? 'zbd-message-row zbd-message-row-user' : 'zbd-message-row', children: _jsxs("div", { className: isUser ? 'zbd-bubble-wrap zbd-bubble-wrap-user' : 'zbd-bubble-wrap', children: [_jsx("div", { className: isUser ? 'zbd-bubble zbd-bubble-user' : 'zbd-bubble zbd-bubble-agent', style: mask, children: isUser ? entry.content : _jsx(RichText, { assetBase: assetBase, content: entry.content }) }), reactions.length > 0 ? (_jsx("span", { className: isUser ? 'zbd-reactions zbd-reactions-user' : 'zbd-reactions zbd-reactions-agent', children: reactions.map((reaction) => (_jsx("span", { className: "zbd-reaction", children: reaction }, reaction))) })) : null] }) })] }));
}
