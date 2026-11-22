import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function OpenLinkAppShell({ children, navigation, overlay, ...props }) {
    return (_jsxs("div", { ...props, children: [navigation, children, overlay] }));
}
export function OpenLinkNavigationRail({ children, footer, ...props }) {
    return (_jsxs("nav", { ...props, children: [_jsx("div", { className: "workspace-navigation-rail-items", children: children }), footer] }));
}
