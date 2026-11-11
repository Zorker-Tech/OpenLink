import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { SafariIcon } from '../components/icons';
export function Dock() {
    return (_jsx("div", { className: "zbd-rd-dock-wrap", children: _jsx("div", { "aria-label": "Applications", className: "zbd-rd-dock", role: "toolbar", children: _jsxs("button", { "aria-label": "Hide CRM portal", className: "zbd-rd-dock-item", "data-visible": "true", tabIndex: -1, type: "button", children: [_jsx("span", { className: "zbd-rd-dock-icon", children: _jsx(SafariIcon, { size: 22 }) }), _jsx("span", { "aria-hidden": "true", className: "zbd-rd-dock-indicator" })] }) }) }));
}
