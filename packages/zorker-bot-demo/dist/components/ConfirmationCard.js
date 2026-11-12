import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * A question the Bot needs answered. It uses the same compact card shell as an
 * activity row so the timeline keeps one rhythm; the answer control stays in
 * the composer dock, where it already lives.
 */
export function ConfirmationCard({ entry }) {
    const { confirmation } = entry;
    const pending = confirmation.status === 'pending';
    return (_jsxs("div", { className: "zbd-activity-card", "data-status": pending ? 'running' : 'done', children: [_jsx("span", { "aria-hidden": "true", className: "zbd-activity-dot" }), _jsxs("span", { className: "zbd-activity-copy", children: [_jsx("span", { className: "zbd-activity-label", children: confirmation.title }), confirmation.message ? (_jsx("span", { className: "zbd-activity-detail", children: confirmation.message })) : null] }), _jsx("span", { className: "zbd-activity-status", children: pending ? 'Answer needed' : 'Answered' })] }));
}
