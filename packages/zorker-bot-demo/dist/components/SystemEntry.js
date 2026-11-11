import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ClockIcon } from './icons';
import { SystemAgentPill } from './SystemAgentPill';
export function SystemEntry({ entry, assetBase }) {
    if (entry.event.type === 'renamed') {
        return _jsxs("div", { className: "zbd-system-line", children: ["Renamed to ", entry.event.name] });
    }
    if (entry.event.type === 'received-context') {
        return (_jsxs("div", { className: "zbd-system-line", children: [_jsx("span", { children: "Messages from" }), entry.event.sources.map((source, index) => (_jsxs("span", { className: "zbd-system-inline", children: [index > 0 ? _jsx("span", { children: "and" }) : null, _jsx(SystemAgentPill, { assetBase: assetBase, name: source.name })] }, source.name)))] }));
    }
    if (entry.event.type === 'created-routine') {
        return (_jsxs("div", { className: "zbd-system-line", children: [_jsx("span", { children: "Created routine" }), _jsxs("span", { className: "zbd-system-routine", children: [_jsx(ClockIcon, { size: 15 }), _jsx("span", { children: entry.event.name })] })] }));
    }
    return _jsx("div", { className: "zbd-system-line", children: "Memory updated" });
}
