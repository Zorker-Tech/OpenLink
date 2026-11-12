"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";
import { AgentAvatarEngine } from "../lib/avatar-engine.js";
import type { AgentAvatarOptions, AvatarPoke } from "../lib/avatar-engine.js";
import type { AgentAvatar3DEngine as AgentAvatar3DEngineType } from "../lib/avatar-engine-3d.js";
import type { AgentAvatarCompleteEngine as AgentAvatarCompleteEngineType } from "../lib/avatar-engine-complete.js";
import type { AgentAvatar25DEngine as AgentAvatar25DEngineType } from "../lib/avatar-engine-25d.js";
import "./AgentAvatar.css";

type ActiveEngine =
  | AgentAvatarEngine
  | AgentAvatar3DEngineType
  | AgentAvatarCompleteEngineType
  | AgentAvatar25DEngineType;

export interface AgentAvatarHandle {
  poke: (action?: AvatarPoke, options?: { turns?: number }) => void;
  setState: (state: string) => void;
  setExpression: (expression: string) => void;
  gazeTo: (vector: { x: number; y: number }) => void;
  resetView: () => void;
  setView: (view: { yaw?: number; pitch?: number; roll?: number }) => void;
  getStaticSvg: (size?: number) => string;
  getPngDataUrl: (size?: number) => Promise<string>;
  getEngine: () => ActiveEngine | null;
}

export interface AgentAvatarProps extends AgentAvatarOptions {
  className?: string;
  style?: CSSProperties;
}

function isPainted(shape: SVGElement) {
  const fill = shape.getAttribute("fill");
  if (fill && fill !== "none" && fill !== "transparent") return true;
  const stroke = shape.getAttribute("stroke");
  return Boolean(stroke && stroke !== "none" && stroke !== "transparent");
}

function hasPaintedFrame(host: HTMLElement) {
  const svg = host.querySelector("svg");
  if (!svg) return false;
  const firstShape = Array.from(
    svg.querySelectorAll<SVGElement>(
      "path, circle, ellipse, rect, polygon, polyline",
    ),
  ).find(
    (shape) => !shape.closest("defs, clipPath, mask, pattern, symbol"),
  );
  return firstShape ? isPainted(firstShape) : false;
}

async function waitForPaintedFrame(host: HTMLElement) {
  for (let frame = 0; frame < 20; frame += 1) {
    if (hasPaintedFrame(host)) return;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
}

export const AgentAvatar = forwardRef<AgentAvatarHandle, AgentAvatarProps>(
  function AgentAvatar({ className = "", style, ...options }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const engineRef = useRef<ActiveEngine | null>(null);
    const renderer = options.renderer ?? "complete";
    const optionsRef = useRef(options);
    optionsRef.current = options;

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return undefined;
      let cancelled = false;
      let engine: ActiveEngine | null = null;

      const boot = async () => {
        host.style.opacity = "0";
        host.dataset.renderer = renderer;
        if (renderer === "svg") {
          engine = new AgentAvatarEngine(host, {
            ...optionsRef.current,
            renderer,
          });
        } else if (renderer === "complete") {
          const { AgentAvatarCompleteEngine } = await import(
            "../lib/avatar-engine-complete.js"
          );
          if (cancelled) return;
          engine = new AgentAvatarCompleteEngine(host, {
            ...optionsRef.current,
            renderer,
          });
        } else if (renderer === "25d") {
          const { AgentAvatar25DEngine } = await import(
            "../lib/avatar-engine-25d.js"
          );
          if (cancelled) return;
          engine = new AgentAvatar25DEngine(host, {
            ...optionsRef.current,
            renderer,
          });
        } else {
          const { AgentAvatar3DEngine } = await import(
            "../lib/avatar-engine-3d.js"
          );
          if (cancelled) return;
          engine = new AgentAvatar3DEngine(host, {
            ...optionsRef.current,
            renderer,
          });
        }
        if (cancelled) {
          engine.destroy();
          return;
        }
        engineRef.current = engine;
        engine.update(optionsRef.current);
        await waitForPaintedFrame(host);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        if (!cancelled) host.style.opacity = "1";
      };

      void boot();
      return () => {
        cancelled = true;
        engine?.destroy();
        if (engineRef.current === engine) engineRef.current = null;
      };
    }, [renderer]);

    useEffect(() => {
      engineRef.current?.update(options);
    }, [options]);

    useImperativeHandle(
      ref,
      () => ({
        poke: (action, pokeOptions) => engineRef.current?.poke(action, pokeOptions),
        setState: (state) => engineRef.current?.setState(state),
        setExpression: (expression) => engineRef.current?.setExpression(expression),
        gazeTo: (vector) => engineRef.current?.gazeTo(vector),
        resetView: () => {
          const engine = engineRef.current;
          if (engine && "resetView" in engine) engine.resetView();
        },
        setView: (view) => {
          const engine = engineRef.current;
          if (engine && "setView" in engine) engine.setView(view);
        },
        getStaticSvg: (size) => engineRef.current?.getStaticSvg(size) ?? "",
        getPngDataUrl: (size) =>
          engineRef.current?.getPngDataUrl(size) ?? Promise.resolve(""),
        getEngine: () => engineRef.current,
      }),
      [],
    );

    return (
      <div
        ref={hostRef}
        className={`agent-avatar-host ${className}`.trim()}
        style={style}
      />
    );
  },
);
