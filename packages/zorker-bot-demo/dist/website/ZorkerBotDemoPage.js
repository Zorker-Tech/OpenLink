'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { ZorkerBotDemo } from '../ZorkerBotDemo';
import '../styles/zorker-bot-demo.css';
export function ZorkerBotDemoPage({ runtimeLabel }) {
    const [runKey, setRunKey] = useState(0);
    return (_jsxs("main", { className: "zbd-demo-page", children: [_jsx("div", { className: "zbd-demo-page-glow", "aria-hidden": "true" }), _jsxs("header", { className: "zbd-demo-page-header", children: [_jsxs("div", { className: "zbd-demo-wordmark", children: [_jsx("span", { className: "zbd-demo-wordmark-mark", "aria-hidden": "true", children: _jsx("img", { alt: "", src: "/zorker-bot-demo/avatars/header.svg" }) }), _jsx("span", { children: "Zorker Bot" })] }), _jsxs("div", { className: "zbd-demo-page-meta", children: [runtimeLabel ? _jsx("span", { className: "zbd-demo-runtime", children: runtimeLabel }) : null, _jsx("button", { className: "zbd-demo-replay", onClick: () => setRunKey((value) => value + 1), type: "button", children: "Replay demo" })] })] }), _jsxs("div", { className: "zbd-demo-page-copy", children: [_jsx("p", { className: "zbd-demo-eyebrow", children: "Always-on AI teammates" }), _jsx("h1", { children: "Zorker Bot gets the work done." }), _jsx("p", { children: "Give a Bot a real task. It can work across your tools, handle the details, and bring back a finished result." })] }), _jsx("div", { className: "zbd-demo-stage-shell", children: _jsx(ZorkerBotDemo, {}, runKey) }), _jsx("p", { className: "zbd-demo-footnote", children: "Zorker Bot \u00B7 auto-playing demo \u00B7 click Replay to restart" })] }));
}
