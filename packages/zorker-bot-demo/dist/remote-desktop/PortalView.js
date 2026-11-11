import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { SkeletonBar } from './SkeletonBar';
const PORTAL_ROWS = [
    { check: false, first: 86, second: 70 },
    { check: true, first: 68, second: 90 },
    { check: true, first: 80, second: 58 },
    { check: true, first: 58, second: 82 },
    { check: true, first: 88, second: 66 },
    { check: true, first: 66, second: 88 },
    { check: true, first: 76, second: 54 },
    { check: true, first: 62, second: 78 },
    { check: true, first: 82, second: 64 },
];
export function PortalView() {
    return (_jsxs("div", { className: "zbd-rd-portal", children: [_jsxs("div", { className: "zbd-rd-sidebar", children: [_jsxs("div", { className: "zbd-rd-sidebar-group", children: [_jsx(SkeletonBar, { width: "62%", opacity: 0.09 }), _jsx(SkeletonBar, { width: "48%", opacity: 0.09 }), _jsx(SkeletonBar, { width: "70%", opacity: 0.09 })] }), _jsxs("div", { className: "zbd-rd-sidebar-group", children: [_jsx(SkeletonBar, { width: "54%", opacity: 0.09 }), _jsx(SkeletonBar, { width: "66%", opacity: 0.09 }), _jsx(SkeletonBar, { width: "44%", opacity: 0.09 }), _jsx(SkeletonBar, { width: "58%", opacity: 0.09 })] })] }), _jsxs("div", { className: "zbd-rd-main", children: [_jsxs("div", { className: "zbd-rd-toolbar", children: [_jsx(SkeletonBar, { width: "30%", opacity: 0.16 }), _jsx("span", { className: "zbd-rd-toolbar-spacer" }), _jsx("span", { className: "zbd-rd-pill", style: {
                                    width: '13%',
                                    height: 7,
                                    background: 'color-mix(in srgb, var(--rd-fg) 5%, transparent)',
                                } }), _jsx("span", { className: "zbd-rd-pill", style: {
                                    width: '17%',
                                    height: 7,
                                    background: 'color-mix(in srgb, var(--rd-fg) 8%, transparent)',
                                } })] }), _jsxs("div", { className: "zbd-rd-columns", children: [_jsx("span", { className: "zbd-rd-column-spacer" }), _jsx("span", { className: "zbd-rd-column", style: { width: 'calc(40% + 11px)' }, children: _jsx(SkeletonBar, { width: "45%", opacity: 0.14 }) }), _jsx("span", { className: "zbd-rd-column", style: { width: '28%' }, children: _jsx(SkeletonBar, { width: "50%", opacity: 0.14 }) }), _jsx(SkeletonBar, { width: "11%", opacity: 0.14 })] }), _jsx("div", { className: "zbd-rd-rows", children: PORTAL_ROWS.map((row, index) => (_jsxs("div", { className: "zbd-rd-row", children: [row.check ? (_jsx("span", { className: "zbd-rd-check", children: _jsxs("svg", { "aria-hidden": "true", fill: "none", height: "6", viewBox: "0 0 12 12", width: "6", children: [_jsx("circle", { cx: "6", cy: "6", opacity: "0.4", r: "5.25", stroke: "currentColor", strokeWidth: "0.75" }), _jsx("path", { d: "M3.75 6.25l1.6 1.6 2.9-3.4", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.25" })] }) })) : (_jsx("span", { className: "zbd-rd-radio" })), _jsx("span", { className: "zbd-rd-row-dot" }), _jsx("span", { className: "zbd-rd-row-cell", style: { width: '40%' }, children: _jsx(SkeletonBar, { width: `${row.first}%`, opacity: 0.1 }) }), _jsx("span", { className: "zbd-rd-row-cell", style: { width: '28%' }, children: _jsx(SkeletonBar, { width: `${row.second}%`, opacity: 0.06 }) }), _jsx(SkeletonBar, { width: "11%", opacity: 0.06 })] }, index))) }), _jsxs("div", { className: "zbd-rd-footer", children: [_jsx("span", { children: "52 accounts" }), _jsx("span", { children: "36 contacts" })] })] })] }));
}
