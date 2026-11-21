'use client';
import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTime } from '../lib/format-time';
import { EmojiPicker } from './EmojiPicker';
import { RichText } from './RichText';
/** Collapse `{emoji, by}` rows into one chip per emoji, preserving order. */
function groupReactions(reactions) {
    const groups = [];
    const index = new Map();
    for (const reaction of reactions) {
        const emoji = reaction.emoji.trim();
        if (!emoji)
            continue;
        const at = index.get(emoji);
        if (at === undefined) {
            index.set(emoji, groups.length);
            groups.push({ emoji, by: [reaction.by] });
        }
        else if (!groups[at].by.includes(reaction.by)) {
            groups[at].by.push(reaction.by);
        }
    }
    return groups;
}
function authorLabel(by) {
    return by === 'me' ? 'You' : by;
}
async function copyMessage(content) {
    if (navigator.clipboard) {
        await navigator.clipboard.writeText(content);
        return true;
    }
    const field = document.createElement('textarea');
    const focused = document.activeElement;
    field.value = content;
    field.style.cssText = 'position: fixed; inset: 0 auto auto 0; opacity: 0; pointer-events: none';
    document.body.append(field);
    try {
        field.select();
        return document.execCommand('copy');
    }
    finally {
        field.remove();
        if (focused instanceof HTMLElement)
            focused.focus({ preventScroll: true });
    }
}
function SmileIcon() {
    return (_jsxs("svg", { "aria-hidden": "true", viewBox: "0 0 16 16", children: [_jsx("circle", { cx: "8", cy: "8", fill: "none", r: "5.9", stroke: "currentColor", strokeWidth: "1.25" }), _jsx("circle", { cx: "6", cy: "6.6", fill: "currentColor", r: "0.85" }), _jsx("circle", { cx: "10", cy: "6.6", fill: "currentColor", r: "0.85" }), _jsx("path", { d: "M5.4 9.3c.6.9 1.5 1.4 2.6 1.4s2-.5 2.6-1.4", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.25" })] }));
}
function CopyIcon() {
    return (_jsxs("svg", { "aria-hidden": "true", viewBox: "0 0 16 16", children: [_jsx("rect", { fill: "none", height: "8.2", rx: "2", stroke: "currentColor", strokeWidth: "1.25", width: "8.2", x: "5.4", y: "5.4" }), _jsx("path", { d: "M10.4 5.2V4.2A2.2 2.2 0 0 0 8.2 2H4.2A2.2 2.2 0 0 0 2 4.2v4c0 1.2 1 2.2 2.2 2.2h1", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.25" })] }));
}
function ReplyIcon() {
    return (_jsx("svg", { "aria-hidden": "true", viewBox: "0 0 16 16", children: _jsx("path", { d: "M6.5 3.5 3 7l3.5 3.5M3.2 7H9a4 4 0 0 1 4 4v1", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.3" }) }));
}
function CheckIcon() {
    return (_jsx("svg", { "aria-hidden": "true", viewBox: "0 0 16 16", children: _jsx("path", { d: "m3.5 8.4 2.8 2.8 6.2-6.4", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.5" }) }));
}
export function MessageBubble({ entry, assetBase, showTimestamp = false, timestampLabel, renderContent, groupPosition = 'single', onReact, onReply, renderMenu, }) {
    const isUser = entry.kind === 'user-message';
    const groups = useMemo(() => groupReactions(entry.reactions ?? []), [entry.reactions]);
    const [reactionState, setReactionState] = useState({ current: groups, rendered: groups });
    if (reactionState.current !== groups) {
        const nextByEmoji = new Map(groups.map((group) => [group.emoji, group]));
        const rendered = reactionState.rendered.map((group) => {
            const updated = nextByEmoji.get(group.emoji);
            nextByEmoji.delete(group.emoji);
            return updated ?? group;
        });
        setReactionState({ current: groups, rendered: [...rendered, ...nextByEmoji.values()] });
    }
    const markdown = !isUser && renderContent !== undefined;
    const [pickerOpen, setPickerOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const reactButtonRef = useRef(null);
    const copyTimer = useRef(null);
    useEffect(() => () => {
        if (copyTimer.current)
            clearTimeout(copyTimer.current);
    }, []);
    const copy = (content = entry.content) => {
        void copyMessage(content).then((didCopy) => {
            if (!didCopy)
                return;
            if (content !== entry.content)
                return;
            setCopied(true);
            if (copyTimer.current)
                clearTimeout(copyTimer.current);
            copyTimer.current = setTimeout(() => setCopied(false), 1_600);
        }).catch(() => undefined);
    };
    const bubble = (_jsx("div", { className: `${isUser ? 'zbd-bubble zbd-bubble-user' : 'zbd-bubble zbd-bubble-agent'}${markdown ? ' zbd-bubble-markdown' : ''}`, "data-group-position": groupPosition, children: isUser ? entry.content : renderContent ? renderContent(entry.content) : _jsx(RichText, { assetBase: assetBase, content: entry.content }) }));
    const react = onReact ? (emoji) => onReact(entry, emoji) : undefined;
    return (_jsxs(_Fragment, { children: [showTimestamp ? (_jsx("div", { className: "zbd-time-separator", suppressHydrationWarning: true, children: timestampLabel ?? formatTime(entry.timestampMs) })) : null, _jsx("div", { className: isUser ? 'zbd-message-row zbd-message-row-user' : 'zbd-message-row', children: _jsxs("div", { className: isUser ? 'zbd-bubble-wrap zbd-bubble-wrap-user' : 'zbd-bubble-wrap', children: [onReact || onReply || entry.content ? (_jsxs("div", { className: "zbd-message-actions", "data-side": isUser ? 'user' : 'agent', children: [onReact ? (_jsx("button", { "aria-expanded": pickerOpen, "aria-haspopup": "dialog", "aria-label": "Add a reaction", className: "zbd-message-action", onClick: () => setPickerOpen((open) => !open), ref: reactButtonRef, title: "Add a reaction", type: "button", children: _jsx(SmileIcon, {}) })) : null, onReply ? (_jsx("button", { "aria-label": "Reply", className: "zbd-message-action", onClick: onReply, title: "Reply", type: "button", children: _jsx(ReplyIcon, {}) })) : null, _jsx("button", { "aria-label": copied ? 'Copied' : 'Copy message', className: "zbd-message-action", onClick: () => copy(), title: copied ? 'Copied' : 'Copy message', type: "button", children: copied ? _jsx(CheckIcon, {}) : _jsx(CopyIcon, {}) })] })) : null, renderMenu ? renderMenu(bubble, { entry, copy, react, reply: onReply, openEmojiPicker: () => setPickerOpen(true) }) : bubble, reactionState.rendered.length > 0 ? (_jsx("span", { className: isUser ? 'zbd-reactions zbd-reactions-user' : 'zbd-reactions zbd-reactions-agent', children: reactionState.rendered.map((group) => {
                                const mine = group.by.includes('me');
                                const leaving = !groups.some(({ emoji }) => emoji === group.emoji);
                                return (_jsxs("button", { "aria-hidden": leaving || undefined, "aria-label": `${group.emoji} reaction from ${group.by.map(authorLabel).join(', ')}`, "aria-pressed": mine, className: mine ? 'zbd-reaction zbd-reaction-mine' : 'zbd-reaction', "data-leaving": leaving || undefined, disabled: leaving, onAnimationEnd: (event) => {
                                        if (!leaving || event.target !== event.currentTarget || event.animationName !== 'zbd-reaction-exit')
                                            return;
                                        setReactionState((state) => state.current.some(({ emoji }) => emoji === group.emoji)
                                            ? state
                                            : { ...state, rendered: state.rendered.filter(({ emoji }) => emoji !== group.emoji) });
                                    }, onClick: () => react?.(group.emoji), title: group.by.map(authorLabel).join(', '), type: "button", children: [_jsx("span", { className: "zbd-reaction-emoji", children: group.emoji }), group.by.length > 1 ? _jsx("span", { className: "zbd-reaction-count", children: group.by.length }) : null] }, group.emoji));
                            }) })) : null, pickerOpen && onReact ? (_jsx(EmojiPicker, { anchor: reactButtonRef.current, onClose: () => setPickerOpen(false), onPick: (emoji) => {
                                onReact(entry, emoji);
                                setPickerOpen(false);
                            } })) : null] }) })] }));
}
