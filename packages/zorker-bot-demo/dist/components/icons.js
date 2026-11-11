var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
function Icon(_a) {
    var { size = 16, children } = _a, props = __rest(_a, ["size", "children"]);
    return (_jsx("svg", Object.assign({ "aria-hidden": "true", fill: "none", height: size, viewBox: "0 0 16 16", width: size, xmlns: "http://www.w3.org/2000/svg" }, props, { children: children })));
}
export function PlusIcon(props) {
    return (_jsx(Icon, Object.assign({}, props, { children: _jsx("path", { d: "M8 3.25v9.5M3.25 8h9.5", stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.4" }) })));
}
export function SearchIcon(props) {
    return (_jsxs(Icon, Object.assign({}, props, { children: [_jsx("circle", { cx: "7.15", cy: "7.15", r: "4.4", stroke: "currentColor", strokeWidth: "1.3" }), _jsx("path", { d: "m10.5 10.5 2.5 2.5", stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.3" })] })));
}
export function MonitorIcon(props) {
    return (_jsxs(Icon, Object.assign({}, props, { children: [_jsx("rect", { height: "8.1", rx: "1.3", stroke: "currentColor", strokeWidth: "1.2", width: "11.4", x: "2.3", y: "2.8" }), _jsx("path", { d: "M6.1 13.3h3.8M8 10.9v2.4", stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.2" })] })));
}
export function MicIcon(props) {
    return (_jsxs(Icon, Object.assign({}, props, { children: [_jsx("rect", { height: "6.1", rx: "2.2", stroke: "currentColor", strokeWidth: "1.25", width: "4.4", x: "5.8", y: "1.9" }), _jsx("path", { d: "M3.7 7.4a4.3 4.3 0 0 0 8.6 0M8 11.7v2.4M5.9 14.1h4.2", stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.25" })] })));
}
export function CloseIcon(props) {
    return (_jsx(Icon, Object.assign({}, props, { children: _jsx("path", { d: "m4 4 8 8M12 4l-8 8", stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.35" }) })));
}
export function GearIcon(props) {
    return (_jsxs(Icon, Object.assign({}, props, { children: [_jsx("circle", { cx: "8", cy: "8", r: "2.15", stroke: "currentColor", strokeWidth: "1.2" }), _jsx("path", { d: "M8 1.9v1.15M8 12.95V14.1M14.1 8h-1.15M3.05 8H1.9M12.31 3.69l-.82.82M4.51 11.49l-.82.82M12.31 12.31l-.82-.82M4.51 4.51l-.82-.82", stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.2" })] })));
}
export function ClockIcon(props) {
    return (_jsxs(Icon, Object.assign({}, props, { children: [_jsx("circle", { cx: "8", cy: "8", r: "5.7", stroke: "currentColor", strokeWidth: "1.2" }), _jsx("path", { d: "M8 4.7V8l2.15 1.5", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.2" })] })));
}
export function ChevronLeftIcon(props) {
    return (_jsx(Icon, Object.assign({}, props, { children: _jsx("path", { d: "m9.8 3.8-4.2 4.2 4.2 4.2", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.4" }) })));
}
export function BackArrowIcon(props) {
    return (_jsx(Icon, Object.assign({}, props, { children: _jsx("path", { d: "M12.7 3.8 6.5 8l6.2 4.2", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.4" }) })));
}
export function SendArrowIcon(props) {
    return (_jsx(Icon, Object.assign({}, props, { children: _jsx("path", { d: "M8 12.7V3.6M4.3 7.3 8 3.6l3.7 3.7", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.5" }) })));
}
export function SpinnerIcon(_a) {
    var { size = 12 } = _a, props = __rest(_a, ["size"]);
    return (_jsxs("svg", Object.assign({ "aria-hidden": "true", className: "zbd-spinner", height: size, viewBox: "0 0 16 16", width: size, xmlns: "http://www.w3.org/2000/svg" }, props, { children: [_jsx("circle", { cx: "8", cy: "8", fill: "none", opacity: "0.24", r: "6", stroke: "currentColor", strokeWidth: "1.7" }), _jsx("path", { d: "M8 2a6 6 0 0 1 6 6", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.7" })] })));
}
export function CursorArrow() {
    return (_jsxs("svg", { "aria-hidden": "true", className: "zbd-cursor-arrow", fill: "none", height: "18", viewBox: "0 0 16 16", width: "18", xmlns: "http://www.w3.org/2000/svg", children: [_jsx("path", { clipRule: "evenodd", d: "M14.4775 2.375C15.1508 2.37522 15.5719 3.10428 15.2353 3.6875L8.63861 15.1143C8.19099 15.8892 7.00618 15.5716 7.00579 14.6768V7.56348L0.845638 4.00781C0.0708241 3.56015 0.388339 2.37535 1.28314 2.375H14.4775ZM7.69329 6.51758C8.04109 6.7186 8.25579 7.09044 8.25579 7.49219V13.2764L13.8271 3.625H2.68353L7.69329 6.51758Z", fill: "white", fillRule: "evenodd" }), _jsx("path", { d: "M7.69329 6.51758C8.04109 6.7186 8.25579 7.09044 8.25579 7.49219V13.2764L13.8271 3.625H2.68353L7.69329 6.51758Z", fill: "#1a1a1a" })] }));
}
export function SafariIcon({ size = 22 }) {
    return (_jsx("svg", { "aria-hidden": "true", height: size, viewBox: "0 0 24 24", width: size, xmlns: "http://www.w3.org/2000/svg", children: _jsxs("g", { children: [_jsx("path", { clipRule: "evenodd", d: "M15.0723 7.59668C15.4541 7.41603 15.9083 7.49433 16.207 7.79297C16.5056 8.09168 16.5839 8.54597 16.4033 8.92773L14.1533 13.6777C14.0545 13.8862 13.8862 14.0545 13.6777 14.1533L8.92773 16.4033C8.54596 16.584 8.0917 16.5056 7.79297 16.207C7.49437 15.9083 7.41612 15.454 7.59668 15.0723L9.84668 10.3223L9.93262 10.1738C10.0313 10.0339 10.1658 9.92085 10.3223 9.84668L15.0723 7.59668ZM12 11C11.4479 11.0001 11.0002 11.4479 11 12C11.0002 12.552 11.4479 12.9999 12 13C12.5521 12.9999 12.9998 12.552 13 12C12.9998 11.4479 12.5521 11.0001 12 11Z", fill: "currentColor", fillRule: "evenodd" }), _jsx("path", { clipRule: "evenodd", d: "M12 2C17.5229 2.00001 22 6.47716 22 12C22 17.5229 17.5229 22 12 22C6.47718 22 2 17.5229 2 12C2 6.47716 6.47717 2 12 2ZM12 4C7.58175 4 4 7.58172 4 12C4 16.4183 7.58174 20 12 20C16.4183 20 20 16.4183 20 12C20 7.58173 16.4183 4.00001 12 4Z", fill: "currentColor", fillRule: "evenodd" })] }) }));
}
