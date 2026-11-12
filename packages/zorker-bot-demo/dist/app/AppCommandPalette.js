import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState, } from 'react';
import { AgentAvatar } from '../components/AgentAvatar';
import { PlusIcon } from '../components/icons';
import { isSessionMatch, sessionToAgent } from './data';
export function AppCommandPalette({ sessions, query, assetBase, onQueryChange, onClose, onSelect, onCreate, }) {
    const inputRef = useRef(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const filtered = sessions.filter(({ session, name }) => isSessionMatch(session, query, name));
    const createItem = { kind: 'create', key: 'create' };
    const sessionItems = filtered.map(({ session, name }) => ({
        kind: 'session',
        key: session.id,
        session,
        name,
    }));
    const items = query.trim().length > 0
        ? [...sessionItems, createItem]
        : [createItem, ...sessionItems];
    useEffect(() => {
        inputRef.current?.focus();
    }, []);
    useEffect(() => {
        setActiveIndex(0);
    }, [query]);
    useEffect(() => {
        const onEscape = (event) => {
            if (event.key === 'Escape')
                onClose();
        };
        document.addEventListener('keydown', onEscape);
        return () => document.removeEventListener('keydown', onEscape);
    }, [onClose]);
    const activate = (item) => {
        if (item.kind === 'create') {
            onCreate(query.trim());
        }
        else {
            onSelect(item.session.id);
        }
    };
    const onKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((index) => Math.min(items.length - 1, index + 1));
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((index) => Math.max(0, index - 1));
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            const item = items[activeIndex];
            if (item)
                activate(item);
        }
    };
    const createLabel = query.trim().length > 0
        ? `Create “${query.trim()}”`
        : 'Create new Bot';
    return (_jsxs("div", { className: "zbd-app-palette-layer", children: [_jsx("button", { "aria-label": "Close agent search", className: "zbd-app-palette-scrim", onClick: onClose, type: "button" }), _jsxs("div", { "aria-label": "Search or create Bots", "aria-modal": "false", className: "zbd-app-palette", role: "dialog", children: [_jsxs("div", { className: "zbd-app-palette-search", children: [_jsx("span", { className: "zbd-app-palette-to", children: "To:" }), _jsx("input", { "aria-label": "Search or create Bots", onChange: (event) => onQueryChange(event.target.value), onKeyDown: onKeyDown, placeholder: "Search or create Bots", ref: inputRef, type: "text", value: query })] }), _jsx("div", { className: "zbd-app-palette-list", role: "listbox", children: items.map((item, index) => {
                            const active = index === activeIndex;
                            if (item.kind === 'create') {
                                return (_jsxs("button", { "aria-selected": active, className: "zbd-app-palette-row", "data-active": active ? '' : undefined, onClick: () => activate(item), onMouseEnter: () => setActiveIndex(index), role: "option", type: "button", children: [_jsx("span", { className: "zbd-app-palette-create-icon", children: _jsx(PlusIcon, { size: 15 }) }), _jsx("span", { className: "zbd-app-palette-row-name", children: createLabel })] }, item.key));
                            }
                            const agent = sessionToAgent(item.session, item.name);
                            return (_jsxs("button", { "aria-selected": active, className: "zbd-app-palette-row", "data-active": active ? '' : undefined, onClick: () => activate(item), onMouseEnter: () => setActiveIndex(index), role: "option", type: "button", children: [_jsx(AgentAvatar, { agent: agent, assetBase: assetBase, size: 22 }), _jsx("span", { className: "zbd-app-palette-row-name", children: item.name })] }, item.key));
                        }) })] })] }));
}
