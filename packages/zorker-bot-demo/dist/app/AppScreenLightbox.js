import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect } from 'react';
import { CloseIcon } from '../components/icons';
import { DesktopPreview } from './DesktopPreview';
export function AppScreenLightbox({ assetBase, displayName, onClose, }) {
    useEffect(() => {
        const close = (event) => {
            if (event.key === 'Escape')
                onClose();
        };
        document.addEventListener('keydown', close);
        return () => document.removeEventListener('keydown', close);
    }, [onClose]);
    return (_jsxs("div", { className: "zbd-app-lightbox", children: [_jsx("button", { "aria-label": "Close screen", className: "zbd-app-lightbox-scrim", onClick: onClose, type: "button" }), _jsxs("div", { "aria-label": `${displayName}'s screen`, "aria-modal": "true", className: "zbd-app-lightbox-panel", role: "dialog", children: [_jsx(DesktopPreview, { assetBase: assetBase }), _jsx("button", { "aria-label": "Close screen", className: "zbd-screen-close", onClick: onClose, type: "button", children: _jsx(CloseIcon, { size: 13 }) })] })] }));
}
