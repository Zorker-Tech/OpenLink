import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState, } from 'react';
import { ClockIcon, MicIcon, PlusIcon, SendArrowIcon, } from '../components/icons';
export function AppComposer({ displayName, disabled, showRoutine = true, status, reply, replyPlaceholder = 'Reply…', value, onChange, onSend, onCreateRoutine, }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef(null);
    const fieldRef = useRef(null);
    const hasText = value.trim().length > 0;
    const isReplying = reply !== undefined;
    const placeholder = isReplying ? replyPlaceholder : `Message ${displayName}`;
    useEffect(() => {
        const node = fieldRef.current;
        if (!node)
            return;
        node.style.height = '0px';
        // The composer grows with the content but never takes more than 40% of
        // the viewport; the transcript keeps the remaining space.
        const maxHeight = Math.max(24, Math.round(window.innerHeight * 0.4));
        node.style.height = `${Math.min(maxHeight, node.scrollHeight)}px`;
    }, [isReplying, value]);
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
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
        }
        if (event.key === 'Escape') {
            if (menuOpen)
                setMenuOpen(false);
            else
                reply?.onCancel();
        }
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
    return (_jsxs("div", { className: "zbd-composer-wrap zbd-app-composer-wrap", children: [status ? _jsx("div", { className: "zbd-composer-status", children: status }) : null, _jsxs("div", { className: "zbd-composer zbd-app-composer", "data-replying": isReplying ? '' : undefined, children: [reply ? (_jsxs("div", { className: "zbd-app-reply-preview", children: [_jsx("button", { className: "zbd-app-reply-excerpt", onClick: reply.onJump, title: reply.excerpt, type: "button", children: reply.excerpt }), _jsx("button", { "aria-label": "Cancel reply", className: "zbd-app-reply-cancel", onClick: () => {
                                    reply.onCancel();
                                    fieldRef.current?.focus({ preventScroll: true });
                                }, type: "button", children: _jsx("span", { "aria-hidden": "true", children: "\u00D7" }) })] })) : null, _jsxs("div", { className: "zbd-app-composer-plus-wrap", ref: menuRef, children: [_jsx("button", { "aria-expanded": menuOpen, "aria-haspopup": "menu", "aria-label": "Add context or routine", className: "zbd-composer-plus zbd-app-composer-plus", disabled: disabled, onClick: () => setMenuOpen((open) => !open), type: "button", children: _jsx(PlusIcon, { size: 16 }) }), menuOpen ? (_jsxs("div", { className: "zbd-app-composer-menu", role: "menu", children: [_jsxs("button", { onClick: addContext, role: "menuitem", type: "button", children: [_jsx("span", { className: "zbd-app-menu-glyph", children: "@" }), _jsxs("span", { children: [_jsx("strong", { children: "Add context" }), _jsx("small", { children: "Bring in an agent or file" })] })] }), showRoutine ? (_jsxs("button", { onClick: createRoutine, role: "menuitem", type: "button", children: [_jsx(ClockIcon, { size: 15 }), _jsxs("span", { children: [_jsx("strong", { children: "Create a routine" }), _jsx("small", { children: "Run this on a schedule" })] })] })) : null] })) : null] }), _jsx("div", { className: "zbd-composer-field zbd-app-composer-field", children: _jsx("textarea", { "aria-label": placeholder, className: "zbd-app-composer-input", disabled: disabled, onChange: (event) => onChange(event.target.value), onKeyDown: onKeyDown, placeholder: placeholder, ref: fieldRef, rows: 1, value: value }) }), _jsxs("div", { className: "zbd-app-composer-actions", children: [_jsx("button", { "aria-label": "Voice message", className: "zbd-composer-mic zbd-app-composer-mic", disabled: disabled, type: "button", children: _jsx(MicIcon, { size: 15 }) }), _jsx("button", { "aria-label": "Send message", className: "zbd-composer-send zbd-app-composer-send", "data-ready": hasText ? '' : undefined, "data-working": disabled ? '' : undefined, disabled: disabled || !hasText, onClick: submit, type: "button", children: _jsx(SendArrowIcon, { size: 16 }) })] })] })] }));
}
