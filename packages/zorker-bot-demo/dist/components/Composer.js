import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { MicIcon, PlusIcon } from './icons';
export function Composer({ agentName }) {
    return (_jsxs("div", { className: "zbd-composer-wrap", children: [_jsx("div", { "aria-hidden": "true", className: "zbd-composer-fade" }), _jsxs("div", { className: "zbd-composer", children: [_jsx("span", { className: "zbd-composer-plus", children: _jsx(PlusIcon, { size: 16 }) }), _jsx("div", { className: "zbd-composer-field", "data-zbd-target": "composer-field", children: _jsxs("span", { className: "zbd-composer-placeholder", children: ["Message ", agentName] }) }), _jsx("button", { "aria-label": "Voice message", className: "zbd-composer-send", tabIndex: -1, type: "button", children: _jsx(MicIcon, { size: 15 }) })] })] }));
}
