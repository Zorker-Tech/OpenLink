import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState, } from 'react';
import { ClockIcon, MicIcon, PlusIcon, SendArrowIcon, } from '../components/icons';
export function AppComposer({ displayName, disabled, showRoutine = true, value, onChange, onSend, onCreateRoutine, }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef(null);
    const fieldRef = useRef(null);
    const hasText = value.trim().length > 0;
    useEffect(() => {
        const node = fieldRef.current;
        if (!node)
            return;
        node.style.height = '0px';
        node.style.height = `${Math.min(112, node.scrollHeight)}px`;
    }, [value]);
    useEffect(() => {
        if (!menuOpen)
            return;
        const close = (event) => {
            if (menuRef.current?.contains(event.target))
                return;
            setMenuOpen(false);
        };
        document.addEventListener('pointerdown', close);
        return () => document.removeEventListener('pointerdown', close);
    }, [menuOpen]);
    const submit = () => {
        if (disabled || !hasText)
            return;
        onSend();
        setMenuOpen(false);
    };
    const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
        }
        if (event.key === 'Escape')
            setMenuOpen(false);
    };
    const addContext = () => {
        const next = value.length === 0 || value.endsWith(' ') ? `${value}@` : `${value} @`;
        onChange(next);
        setMenuOpen(false);
        window.requestAnimationFrame(() => fieldRef.current?.focus());
    };
    const createRoutine = () => {
        onCreateRoutine();
        setMenuOpen(false);
    };
    return (_jsxs("div", { className: "zbd-composer-wrap zbd-app-composer-wrap", children: [_jsx("div", { "aria-hidden": "true", className: "zbd-composer-fade" }), _jsxs("div", { className: "zbd-composer zbd-app-composer", children: [_jsxs("div", { className: "zbd-app-composer-plus-wrap", ref: menuRef, children: [_jsx("button", { "aria-expanded": menuOpen, "aria-haspopup": "menu", "aria-label": "Add context or routine", className: "zbd-composer-plus zbd-app-composer-plus", disabled: disabled, onClick: () => setMenuOpen((open) => !open), type: "button", children: _jsx(PlusIcon, { size: 16 }) }), menuOpen ? (_jsxs("div", { className: "zbd-app-composer-menu", role: "menu", children: [_jsxs("button", { onClick: addContext, role: "menuitem", type: "button", children: [_jsx("span", { className: "zbd-app-menu-glyph", children: "@" }), _jsxs("span", { children: [_jsx("strong", { children: "Add context" }), _jsx("small", { children: "Bring in an agent or file" })] })] }), showRoutine ? (_jsxs("button", { onClick: createRoutine, role: "menuitem", type: "button", children: [_jsx(ClockIcon, { size: 15 }), _jsxs("span", { children: [_jsx("strong", { children: "Create a routine" }), _jsx("small", { children: "Run this on a schedule" })] })] })) : null] })) : null] }), _jsx("div", { className: "zbd-composer-field zbd-app-composer-field", children: _jsx("textarea", { "aria-label": `Message ${displayName}`, className: "zbd-app-composer-input", disabled: disabled, onChange: (event) => onChange(event.target.value), onKeyDown: onKeyDown, placeholder: `Message ${displayName}`, ref: fieldRef, rows: 1, value: value }) }), _jsx("button", { "aria-label": hasText ? 'Send message' : 'Voice message', className: "zbd-composer-send zbd-app-composer-send", "data-working": disabled ? '' : undefined, disabled: disabled || !hasText, onClick: submit, tabIndex: hasText ? 0 : -1, type: "button", children: hasText ? _jsx(SendArrowIcon, { size: 16 }) : _jsx(MicIcon, { size: 15 }) })] })] }));
}
