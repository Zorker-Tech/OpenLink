import { jsx as _jsx } from "react/jsx-runtime";
import { RemoteDesktop } from '../remote-desktop/RemoteDesktop';
export function ScreenFrame({ assetBase, screen, height, className, frameRef, }) {
    return (_jsx("div", { "aria-label": "Sales Outbound's screen", "aria-modal": "true", className: `zbd-screen-frame ${className !== null && className !== void 0 ? className : ''}`, ref: frameRef, role: "dialog", style: { height, width: height * 1.6 }, children: _jsx(RemoteDesktop, { agentCursor: screen.isWorking, assetBase: assetBase, emailChars: screen.emailChars, focus: screen.focus, passwordChars: screen.passwordChars, showDock: true, view: screen.view }) }));
}
