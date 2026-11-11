import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useLayoutEffect, useRef, useState } from 'react';
import { CloseIcon } from './icons';
import { ScreenFrame } from './ScreenFrame';
export function ScreenOverlay({ overlay, screen, rootWidth, rootHeight, assetBase, onClose, onFinish, }) {
    var _a;
    const frameRef = useRef(null);
    const [animated, setAnimated] = useState(false);
    const [from, setFrom] = useState(null);
    const takeover = overlay.mode === 'takeover';
    const frameHeight = takeover
        ? Math.min(rootHeight - 118, rootWidth * 0.625 - 50, 494)
        : Math.min(rootHeight - 72, rootWidth * 0.625 - 45, 512);
    const frameWidth = frameHeight * 1.6;
    useLayoutEffect(() => {
        const frame = frameRef.current;
        const thumb = document.querySelector('[data-zbd-thumb="computer"]');
        if (!frame || !thumb) {
            setAnimated(true);
            return;
        }
        const frameRect = frame.getBoundingClientRect();
        const thumbRect = thumb.getBoundingClientRect();
        setFrom({
            x: thumbRect.left - frameRect.left,
            y: thumbRect.top - frameRect.top,
            scale: thumbRect.width / frameRect.width,
        });
        const raf = requestAnimationFrame(() => setAnimated(true));
        return () => cancelAnimationFrame(raf);
    }, []);
    const flipStyle = {
        transform: !animated && from
            ? `translate(${from.x}px, ${from.y}px) scale(${from.scale})`
            : 'none',
        transformOrigin: 'top left',
        transition: animated ? 'transform .45s cubic-bezier(.22,1,.36,1)' : 'none',
    };
    return (_jsxs("div", { className: "zbd-screen-layer", children: [_jsx("button", { "aria-label": "Close screen", className: "zbd-screen-scrim", onClick: onClose, style: { opacity: animated ? 1 : 0 }, type: "button" }), takeover ? (_jsxs("div", { className: "zbd-screen-shell", style: { width: frameWidth + 24, height: frameHeight + 62 }, children: [_jsx("div", { className: "zbd-screen-surface", style: { opacity: animated ? 1 : 0, transition: 'opacity .2s ease .5s' } }), _jsxs("div", { className: "zbd-screen-banner", style: { opacity: animated ? 1 : 0, transition: 'opacity .2s ease .5s' }, children: [_jsx("span", { className: "zbd-screen-banner-label", children: (_a = overlay.instruction) !== null && _a !== void 0 ? _a : 'You’re in control' }), _jsx("button", { className: "zbd-screen-banner-done", "data-zbd-target": "screen-done", onClick: onFinish, type: "button", children: "I\u2019m done, continue" })] }), _jsx("div", { className: "zbd-screen-frame-slot", style: flipStyle, children: _jsx(ScreenFrame, { assetBase: assetBase, frameRef: frameRef, height: frameHeight, screen: screen }) })] })) : (_jsxs("div", { className: "zbd-screen-frame-slot zbd-screen-frame-slot-lightbox", style: flipStyle, children: [_jsx(ScreenFrame, { assetBase: assetBase, frameRef: frameRef, height: frameHeight, screen: screen }), _jsx("button", { "aria-label": "Close screen", className: "zbd-screen-close", onClick: onClose, type: "button", children: _jsx(CloseIcon, { size: 13 }) })] }))] }));
}
