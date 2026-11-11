import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function PendingRow({ pending, assetBase }) {
    const label = pending.label && pending.showLabel ? pending.label : 'Thinking';
    return (_jsxs("div", { className: "zbd-pending", children: [_jsx("span", { className: "zbd-pending-avatar", children: _jsx("img", { alt: "", draggable: false, src: `${assetBase}/avatars/header.svg` }) }), _jsx("span", { className: "zbd-pending-label", children: label })] }));
}
