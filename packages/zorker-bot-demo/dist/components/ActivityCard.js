import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
function statusLabel(status) {
    if (status === 'failed')
        return 'Failed';
    if (status === 'done')
        return 'Done';
    return 'Working';
}
export function ActivityCard({ entry }) {
    const { activity } = entry;
    return (_jsxs("div", { className: "zbd-activity-card", "data-status": activity.status, children: [_jsx("span", { "aria-hidden": "true", className: "zbd-activity-dot" }), _jsxs("span", { className: "zbd-activity-copy", children: [_jsx("span", { className: "zbd-activity-label", children: activity.label }), activity.detail ? _jsx("span", { className: "zbd-activity-detail", children: activity.detail }) : null] }), _jsx("span", { className: "zbd-activity-status", children: statusLabel(activity.status) })] }));
}
