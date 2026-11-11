import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { SpinnerIcon } from './icons';
export function ComputerBadge({ status }) {
    if (status === 'action-needed') {
        return (_jsxs("span", { className: "zbd-card-badge", "data-tone": "warning", children: [_jsx(SpinnerIcon, { size: 12 }), "Action needed"] }));
    }
    if (status === 'handed-over') {
        return (_jsxs("span", { className: "zbd-card-badge", "data-tone": "warning", children: [_jsx("span", { className: "zbd-card-badge-dot" }), "You\u2019re in control"] }));
    }
    if (status === 'working') {
        return (_jsxs("span", { className: "zbd-card-badge", "data-tone": "accent", children: [_jsx(SpinnerIcon, { size: 12 }), "Working"] }));
    }
    return (_jsxs("span", { className: "zbd-card-badge", "data-tone": "success", children: [_jsx("span", { className: "zbd-card-badge-dot" }), "Done"] }));
}
