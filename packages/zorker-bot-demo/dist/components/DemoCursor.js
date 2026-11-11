import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CursorArrow } from './icons';
export function DemoCursor({ cursor, ripples }) {
    return (_jsxs(_Fragment, { children: [ripples.map((ripple) => (_jsx("span", { className: "zbd-cursor-ripple", style: { left: ripple.x, top: ripple.y } }, ripple.id))), _jsxs("div", { className: "zbd-cursor", style: {
                    opacity: cursor.visible ? 1 : 0,
                    transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)`,
                    transition: `transform ${cursor.duration}ms cubic-bezier(.3,.1,.25,1), opacity .25s ease`,
                }, children: [_jsx(CursorArrow, {}), _jsx("span", { className: "zbd-cursor-label", children: "You" })] })] }));
}
