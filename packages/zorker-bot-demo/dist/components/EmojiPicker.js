'use client';
import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import compactEmojiData from 'emojibase-data/en/compact.json';
const EMOJIS = compactEmojiData
    .filter((emoji) => (typeof emoji.unicode === 'string'
    && emoji.unicode.length > 0
    // Regional indicators are building blocks for flag sequences; showing
    // them as standalone cells reads as letter tiles, not emoji.
    && typeof emoji.group === 'number'))
    .slice()
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
const GROUPS = [
    { id: 0, label: 'Smileys & Emotion', glyph: '😀' },
    { id: 1, label: 'People & Body', glyph: '👋' },
    { id: 2, label: 'Components', glyph: '🦰' },
    { id: 3, label: 'Animals & Nature', glyph: '🐻' },
    { id: 4, label: 'Food & Drink', glyph: '🍔' },
    { id: 5, label: 'Travel & Places', glyph: '✈️' },
    { id: 6, label: 'Activities', glyph: '⚽' },
    { id: 7, label: 'Objects', glyph: '💡' },
    { id: 8, label: 'Symbols', glyph: '❤️' },
    { id: 9, label: 'Flags', glyph: '🏳️' },
];
export const QUICK_REACTIONS = ['🫠', '👍', '😂', '👎', '❤️'];
const RECENT_KEY = 'openlink-emoji-recent';
const RECENT_LIMIT = 18;
const PICKER_WIDTH = 320;
const PICKER_HEIGHT = 384;
function readRecent() {
    try {
        const raw = window.localStorage.getItem(RECENT_KEY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.flatMap((value) => (typeof value === 'string' && value.length > 0 ? [value] : [])).slice(0, RECENT_LIMIT);
    }
    catch {
        return [];
    }
}
function rememberRecent(emoji) {
    const next = [emoji, ...readRecent().filter((value) => value !== emoji)].slice(0, RECENT_LIMIT);
    try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    }
    catch {
        // A private window can refuse storage; the picker still works.
    }
    return next;
}
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
}
/**
 * A reaction picker with a search field, quick reactions, grouped sections and
 * a category rail. It is portalled to the body so the transcript's scroll
 * container cannot clip it.
 */
export function EmojiPicker({ anchor, onPick, onClose }) {
    const [query, setQuery] = useState('');
    const [recent, setRecent] = useState([]);
    const [theme, setTheme] = useState('bot-light');
    const [hovered, setHovered] = useState('');
    const [position, setPosition] = useState({ left: 0, top: 0, visibility: 'hidden' });
    const panelRef = useRef(null);
    const scrollRef = useRef(null);
    const inputRef = useRef(null);
    useEffect(() => {
        setRecent(readRecent());
        setTheme(document.documentElement.classList.contains('dark') ? 'bot-dark' : 'bot-light');
    }, []);
    useEffect(() => {
        if (position.visibility !== 'hidden')
            inputRef.current?.focus({ preventScroll: true });
    }, [position.visibility]);
    useEffect(() => {
        if (!anchor)
            return;
        const place = () => {
            const rect = anchor.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const width = Math.min(PICKER_WIDTH, viewportWidth - 16);
            const height = Math.min(PICKER_HEIGHT, viewportHeight - 16);
            const left = clamp(rect.left + rect.width / 2 - width / 2, 8, viewportWidth - width - 8);
            const below = rect.bottom + 8;
            const top = below + height <= viewportHeight - 8
                ? below
                : clamp(rect.top - height - 8, 8, viewportHeight - height - 8);
            setPosition({ left, top, width, height });
        };
        place();
        const closeOnViewportChange = (event) => {
            if (event.target instanceof Node && panelRef.current?.contains(event.target))
                return;
            onClose();
        };
        window.addEventListener('resize', closeOnViewportChange);
        window.addEventListener('scroll', closeOnViewportChange, true);
        return () => {
            window.removeEventListener('resize', closeOnViewportChange);
            window.removeEventListener('scroll', closeOnViewportChange, true);
        };
    }, [anchor, onClose]);
    useEffect(() => {
        const onPointerDown = (event) => {
            const target = event.target;
            if (!(target instanceof Node))
                return;
            if (panelRef.current?.contains(target))
                return;
            if (anchor?.contains(target))
                return;
            onClose();
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape')
                onClose();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [anchor, onClose]);
    const normalizedQuery = query.trim().toLowerCase();
    const results = useMemo(() => {
        if (!normalizedQuery)
            return null;
        return EMOJIS.filter((emoji) => {
            if (emoji.label.toLowerCase().includes(normalizedQuery))
                return true;
            const emoticons = typeof emoji.emoticon === 'string' ? [emoji.emoticon] : emoji.emoticon;
            if (emoticons?.some((emoticon) => emoticon.toLowerCase() === normalizedQuery))
                return true;
            return emoji.tags?.some((tag) => tag.toLowerCase().includes(normalizedQuery)) ?? false;
        }).slice(0, 120);
    }, [normalizedQuery]);
    const byGroup = useMemo(() => {
        const groups = new Map();
        for (const emoji of EMOJIS) {
            const group = emoji.group ?? 0;
            const bucket = groups.get(group);
            if (bucket)
                bucket.push(emoji);
            else
                groups.set(group, [emoji]);
        }
        return groups;
    }, []);
    const pick = (emoji) => {
        setRecent(rememberRecent(emoji));
        onPick(emoji);
    };
    const grid = (emojis) => (_jsx("div", { className: "zbd-emoji-grid", children: emojis.map((emoji) => (_jsx("button", { "aria-label": emoji.label, className: "zbd-emoji-cell", onClick: () => pick(emoji.unicode), onContextMenu: (event) => {
                event.preventDefault();
                setRecent(rememberRecent(emoji.unicode));
            }, onMouseEnter: () => setHovered(emoji.label), onMouseLeave: () => setHovered(''), title: emoji.label, type: "button", children: emoji.unicode }, emoji.unicode))) }));
    return createPortal(_jsxs("div", { "aria-label": "Add a reaction", className: "zbd-emoji-picker", "data-theme": theme, ref: panelRef, role: "dialog", style: position, children: [_jsxs("div", { className: "zbd-emoji-search", children: [_jsxs("svg", { "aria-hidden": "true", className: "zbd-emoji-search-icon", viewBox: "0 0 16 16", children: [_jsx("circle", { cx: "7", cy: "7", fill: "none", r: "4.4", stroke: "currentColor", strokeWidth: "1.3" }), _jsx("path", { d: "m10.3 10.3 3 3", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.3" })] }), _jsx("input", { "aria-label": "Search emoji", onChange: (event) => setQuery(event.target.value), placeholder: "Search emoji", ref: inputRef, type: "search", value: query })] }), !normalizedQuery ? (_jsx("div", { className: "zbd-emoji-quick", "aria-label": "Quick reactions", children: QUICK_REACTIONS.map((emoji) => (_jsx("button", { "aria-label": `React with ${emoji}`, className: "zbd-emoji-quick-cell", onClick: () => pick(emoji), type: "button", children: emoji }, emoji))) })) : null, _jsx("div", { className: "zbd-emoji-scroll", ref: scrollRef, children: normalizedQuery ? (results && results.length > 0 ? (_jsxs("section", { className: "zbd-emoji-section", children: [_jsx("h3", { className: "zbd-emoji-heading", children: "Results" }), grid(results)] })) : (_jsxs("p", { className: "zbd-emoji-empty", children: ["No emoji matches \u201C", query.trim(), "\u201D."] }))) : (_jsxs(_Fragment, { children: [recent.length > 0 ? (_jsxs("section", { className: "zbd-emoji-section", children: [_jsx("h3", { className: "zbd-emoji-heading", children: "Recently used" }), _jsx("div", { className: "zbd-emoji-grid", children: recent.map((emoji) => (_jsx("button", { "aria-label": `React with ${emoji}`, className: "zbd-emoji-cell", onClick: () => pick(emoji), type: "button", children: emoji }, `recent-${emoji}`))) })] })) : null, GROUPS.map((group) => {
                            const emojis = byGroup.get(group.id) ?? [];
                            if (emojis.length === 0)
                                return null;
                            return (_jsxs("section", { className: "zbd-emoji-section", children: [_jsx("h3", { className: "zbd-emoji-heading", children: group.label }), grid(emojis)] }, group.id));
                        })] })) }), _jsxs("div", { className: "zbd-emoji-footer", children: [_jsx("span", { className: "zbd-emoji-footer-label", children: hovered || 'Emoji' }), _jsx("span", { className: "zbd-emoji-footer-hint", children: "Right-click to pin" })] })] }), document.body);
}
