import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const GENERIC_LABELS = new Set(['Working', 'Thinking']);
/**
 * The turn is in flight. Show the same three-dot beat the reference surface
 * uses, inside the transcript, instead of a static "Working" label. A concrete
 * tool/status label is still shown when the host provides one.
 */
export function PendingRow({ pending }) {
    const label = pending.label && pending.showLabel && !GENERIC_LABELS.has(pending.label)
        ? pending.label
        : '';
    return (_jsxs("div", { "aria-label": label || 'Typing', className: "zbd-pending", role: "status", children: [_jsxs("span", { "aria-hidden": "true", className: "zbd-typing-dots", children: [_jsx("span", { className: "zbd-typing-dot" }), _jsx("span", { className: "zbd-typing-dot" }), _jsx("span", { className: "zbd-typing-dot" })] }), label ? _jsx("span", { className: "zbd-pending-label", children: label }) : null] }));
}
