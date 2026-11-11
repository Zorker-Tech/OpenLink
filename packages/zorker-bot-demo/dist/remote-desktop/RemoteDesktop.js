'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Dock } from './Dock';
import { LoginView } from './LoginView';
import { PortalView } from './PortalView';
import { useDesktopScale } from './useDesktopScale';
export function RemoteDesktop({ assetBase, view, emailChars = 0, passwordChars = 0, focus = null, showDock = true, agentCursor = false, className, }) {
    const { ref, scale } = useDesktopScale();
    return (_jsxs("div", { className: `zbd-rd ${className !== null && className !== void 0 ? className : ''}`, ref: ref, style: { ['--rd-scale']: scale }, children: [_jsx("img", { alt: "", className: "zbd-rd-wallpaper", draggable: false, src: `${assetBase}/wallpaper-light.webp` }), _jsx("div", { className: "zbd-rd-window", children: _jsxs("div", { className: "zbd-rd-window-inner", style: {
                        width: 'calc(360px * 0.5)',
                        height: 'calc(225px * 0.72)',
                        transform: `scale(${scale})`,
                    }, children: [_jsxs("div", { className: "zbd-rd-titlebar", children: [_jsx("span", {}), _jsx("span", {}), _jsx("span", {})] }), _jsx("div", { "aria-hidden": "true", className: "zbd-rd-addressbar", children: _jsx("span", {}) }), view === 'login' ? (_jsx(LoginView, { emailChars: emailChars, focus: focus, passwordChars: passwordChars })) : (_jsx(PortalView, {}))] }) }), agentCursor ? (_jsx("div", { className: "zbd-rd-agent-cursor", children: _jsx(AgentCursorArrow, {}) })) : null, showDock ? _jsx(Dock, {}) : null] }));
}
function AgentCursorArrow() {
    return (_jsx("svg", { "aria-hidden": "true", height: "13", viewBox: "0 0 16 16", width: "13", children: _jsx("path", { d: "M2 1.8 13.2 8.2l-5.1.9-2.7 4.4L2 1.8Z", fill: "#F19D38", stroke: "#fff", strokeLinejoin: "round", strokeWidth: "1.1" }) }));
}
