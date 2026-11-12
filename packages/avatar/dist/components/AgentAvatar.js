"use client";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
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
import { jsx as _jsx } from "react/jsx-runtime";
import { forwardRef, useEffect, useImperativeHandle, useRef, } from "react";
import { AgentAvatarEngine } from "../lib/avatar-engine.js";
import "./AgentAvatar.css";
function isPainted(shape) {
    const fill = shape.getAttribute("fill");
    if (fill && fill !== "none" && fill !== "transparent")
        return true;
    const stroke = shape.getAttribute("stroke");
    return Boolean(stroke && stroke !== "none" && stroke !== "transparent");
}
function hasPaintedFrame(host) {
    const svg = host.querySelector("svg");
    if (!svg)
        return false;
    const firstShape = Array.from(svg.querySelectorAll("path, circle, ellipse, rect, polygon, polyline")).find((shape) => !shape.closest("defs, clipPath, mask, pattern, symbol"));
    return firstShape ? isPainted(firstShape) : false;
}
function waitForPaintedFrame(host) {
    return __awaiter(this, void 0, void 0, function* () {
        for (let frame = 0; frame < 20; frame += 1) {
            if (hasPaintedFrame(host))
                return;
            yield new Promise((resolve) => requestAnimationFrame(() => resolve()));
        }
    });
}
export const AgentAvatar = forwardRef(function AgentAvatar(_a, ref) {
    var _b;
    var { className = "", style } = _a, options = __rest(_a, ["className", "style"]);
    const hostRef = useRef(null);
    const engineRef = useRef(null);
    const renderer = (_b = options.renderer) !== null && _b !== void 0 ? _b : "complete";
    const optionsRef = useRef(options);
    optionsRef.current = options;
    useEffect(() => {
        const host = hostRef.current;
        if (!host)
            return undefined;
        let cancelled = false;
        let engine = null;
        const boot = () => __awaiter(this, void 0, void 0, function* () {
            host.style.opacity = "0";
            host.dataset.renderer = renderer;
            if (renderer === "svg") {
                engine = new AgentAvatarEngine(host, Object.assign(Object.assign({}, optionsRef.current), { renderer }));
            }
            else if (renderer === "complete") {
                const { AgentAvatarCompleteEngine } = yield import("../lib/avatar-engine-complete.js");
                if (cancelled)
                    return;
                engine = new AgentAvatarCompleteEngine(host, Object.assign(Object.assign({}, optionsRef.current), { renderer }));
            }
            else if (renderer === "25d") {
                const { AgentAvatar25DEngine } = yield import("../lib/avatar-engine-25d.js");
                if (cancelled)
                    return;
                engine = new AgentAvatar25DEngine(host, Object.assign(Object.assign({}, optionsRef.current), { renderer }));
            }
            else {
                const { AgentAvatar3DEngine } = yield import("../lib/avatar-engine-3d.js");
                if (cancelled)
                    return;
                engine = new AgentAvatar3DEngine(host, Object.assign(Object.assign({}, optionsRef.current), { renderer }));
            }
            if (cancelled) {
                engine.destroy();
                return;
            }
            engineRef.current = engine;
            engine.update(optionsRef.current);
            yield waitForPaintedFrame(host);
            yield new Promise((resolve) => requestAnimationFrame(() => resolve()));
            if (!cancelled)
                host.style.opacity = "1";
        });
        void boot();
        return () => {
            cancelled = true;
            engine === null || engine === void 0 ? void 0 : engine.destroy();
            if (engineRef.current === engine)
                engineRef.current = null;
        };
    }, [renderer]);
    useEffect(() => {
        var _a;
        (_a = engineRef.current) === null || _a === void 0 ? void 0 : _a.update(options);
    }, [options]);
    useImperativeHandle(ref, () => ({
        poke: (action, pokeOptions) => { var _a; return (_a = engineRef.current) === null || _a === void 0 ? void 0 : _a.poke(action, pokeOptions); },
        setState: (state) => { var _a; return (_a = engineRef.current) === null || _a === void 0 ? void 0 : _a.setState(state); },
        setExpression: (expression) => { var _a; return (_a = engineRef.current) === null || _a === void 0 ? void 0 : _a.setExpression(expression); },
        gazeTo: (vector) => { var _a; return (_a = engineRef.current) === null || _a === void 0 ? void 0 : _a.gazeTo(vector); },
        resetView: () => {
            const engine = engineRef.current;
            if (engine && "resetView" in engine)
                engine.resetView();
        },
        setView: (view) => {
            const engine = engineRef.current;
            if (engine && "setView" in engine)
                engine.setView(view);
        },
        getStaticSvg: (size) => { var _a; var _b; return (_b = (_a = engineRef.current) === null || _a === void 0 ? void 0 : _a.getStaticSvg(size)) !== null && _b !== void 0 ? _b : ""; },
        getPngDataUrl: (size) => { var _a; var _b; return (_b = (_a = engineRef.current) === null || _a === void 0 ? void 0 : _a.getPngDataUrl(size)) !== null && _b !== void 0 ? _b : Promise.resolve(""); },
        getEngine: () => engineRef.current,
    }), []);
    return (_jsx("div", { ref: hostRef, className: `agent-avatar-host ${className}`.trim(), style: style }));
});
