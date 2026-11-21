import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useId, useRef, useState, } from 'react';
import { ClockIcon, MicIcon, PlusIcon, SendArrowIcon, } from '../components/icons';
export function AppComposer({ displayName, disabled, showRoutine = true, status, reply, replyPlaceholder = 'Reply…', groupMembers, value, onChange, onSend, onCreateRoutine, }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [caret, setCaret] = useState(0);
    const [mentionIndex, setMentionIndex] = useState(0);
    const [dismissedMention, setDismissedMention] = useState(null);
    const mentionListId = useId();
    const menuRef = useRef(null);
    const fieldRef = useRef(null);
    const hasText = value.trim().length > 0;
    const isReplying = reply !== undefined;
    const placeholder = isReplying ? replyPlaceholder : `Message ${displayName}`;
    const mention = groupMembers && !disabled && value !== dismissedMention ? /(?:^|\s)@([^@\n]{0,64})$/u.exec(value.slice(0, caret)) : null;
    const query = mention?.[1]?.toLocaleLowerCase() ?? '';
    const choices = mention && query === query.trimEnd() ? [
        { id: 'everyone', name: 'Everyone', insert: 'everyone' },
        ...(groupMembers ?? []).map(({ id, name }) => ({ id, name, insert: name })),
    ].filter(({ name, insert }) => name.toLocaleLowerCase().includes(query) || insert.toLocaleLowerCase().startsWith(query)) : [];
    const selectedMention = Math.min(mentionIndex, Math.max(0, choices.length - 1));
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
        if (event.nativeEvent.isComposing)
            return;
        if (choices.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            setMentionIndex((selectedMention + direction + choices.length) % choices.length);
            return;
        }
        if (choices.length && event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            insertMention(choices[selectedMention].insert);
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
        }
        if (event.key === 'Escape') {
            if (choices.length)
                setDismissedMention(value);
            else if (menuOpen)
                setMenuOpen(false);
            else
                reply?.onCancel();
        }
    };
    const addContext = () => {
        const next = value.length === 0 || value.endsWith(' ') ? `${value}@` : `${value} @`;
        onChange(next);
        setCaret(next.length);
        setMentionIndex(0);
        setDismissedMention(null);
        setMenuOpen(false);
        window.requestAnimationFrame(() => fieldRef.current?.focus());
    };
    const insertMention = (name) => {
        if (!mention)
            return;
        const start = caret - (mention[1]?.length ?? 0) - 1;
        const added = `@${name} `;
        const next = value.slice(0, start) + added + value.slice(caret);
        onChange(next);
        setDismissedMention(null);
        setCaret(start + added.length);
        window.requestAnimationFrame(() => {
            const field = fieldRef.current;
            field?.focus({ preventScroll: true });
            field?.setSelectionRange(start + added.length, start + added.length);
        });
    };
    const createRoutine = () => {
        onCreateRoutine?.();
        setMenuOpen(false);
    };
    return (_jsxs("div", { className: "zbd-composer-wrap zbd-app-composer-wrap", children: [status ? _jsx("div", { className: "zbd-composer-status", children: status }) : null, _jsxs("div", { className: "zbd-composer zbd-app-composer", "data-replying": isReplying ? '' : undefined, children: [reply ? (_jsxs("div", { className: "zbd-app-reply-preview", children: [_jsx("button", { className: "zbd-app-reply-excerpt", onClick: reply.onJump, title: reply.excerpt, type: "button", children: reply.excerpt }), _jsx("button", { "aria-label": "Cancel reply", className: "zbd-app-reply-cancel", onClick: () => {
                                    reply.onCancel();
                                    fieldRef.current?.focus({ preventScroll: true });
                                }, type: "button", children: _jsx("span", { "aria-hidden": "true", children: "\u00D7" }) })] })) : null, _jsxs("div", { className: "zbd-app-composer-plus-wrap", ref: menuRef, children: [_jsx("button", { "aria-expanded": menuOpen, "aria-haspopup": "menu", "aria-label": "Add context or routine", className: "zbd-composer-plus zbd-app-composer-plus", disabled: disabled, onClick: () => setMenuOpen((open) => !open), type: "button", children: _jsx(PlusIcon, { size: 16 }) }), menuOpen ? (_jsxs("div", { className: "zbd-app-composer-menu", role: "menu", children: [_jsxs("button", { onClick: addContext, role: "menuitem", type: "button", children: [_jsx("span", { className: "zbd-app-menu-glyph", children: "@" }), _jsxs("span", { children: [_jsx("strong", { children: groupMembers ? 'Mention a member' : 'Add context' }), _jsx("small", { children: groupMembers ? 'Address someone in this group' : 'Bring in an agent or file' })] })] }), showRoutine && onCreateRoutine ? (_jsxs("button", { onClick: createRoutine, role: "menuitem", type: "button", children: [_jsx(ClockIcon, { size: 15 }), _jsxs("span", { children: [_jsx("strong", { children: "Create a routine" }), _jsx("small", { children: "Run this on a schedule" })] })] })) : null] })) : null] }), _jsxs("div", { className: "zbd-composer-field zbd-app-composer-field", children: [choices.length ? (_jsx("ul", { "aria-label": "Group members", className: "zbd-app-group-mentions", id: mentionListId, role: "listbox", children: choices.map((choice, index) => (_jsx("li", { "aria-selected": index === selectedMention, id: `${mentionListId}-${index}`, role: "option", children: _jsxs("button", { onClick: () => insertMention(choice.insert), onMouseDown: (event) => event.preventDefault(), tabIndex: -1, type: "button", children: [_jsx("span", { "aria-hidden": "true", children: "@" }), " ", choice.name] }) }, choice.id))) })) : null, _jsx("textarea", { "aria-label": placeholder, "aria-autocomplete": groupMembers ? 'list' : undefined, "aria-controls": choices.length ? mentionListId : undefined, "aria-activedescendant": choices.length ? `${mentionListId}-${selectedMention}` : undefined, className: "zbd-app-composer-input", disabled: disabled, onChange: (event) => {
                                    setCaret(event.currentTarget.selectionStart);
                                    setMentionIndex(0);
                                    setDismissedMention(null);
                                    onChange(event.currentTarget.value);
                                }, onKeyDown: onKeyDown, onSelect: (event) => setCaret(event.currentTarget.selectionStart), placeholder: placeholder, ref: fieldRef, rows: 1, value: value })] }), _jsxs("div", { className: "zbd-app-composer-actions", children: [_jsx("button", { "aria-label": "Voice message", className: "zbd-composer-mic zbd-app-composer-mic", disabled: disabled, type: "button", children: _jsx(MicIcon, { size: 15 }) }), _jsx("button", { "aria-label": "Send message", className: "zbd-composer-send zbd-app-composer-send", "data-ready": hasText ? '' : undefined, "data-working": disabled ? '' : undefined, disabled: disabled || !hasText, onClick: submit, type: "button", children: _jsx(SendArrowIcon, { size: 16 }) })] })] })] }));
}
