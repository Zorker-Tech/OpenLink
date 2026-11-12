/**
 * Botform Avatar 3D Engine
 *
 * The complete flat/stem core plus yaw / pitch view rotation. The body keeps
 * the exact palette fill and the full clip library; only the observation angle
 * changes. Drag inertia and the seven view presets live here.
 */

import { createAvatarEngine } from "./avatar-core.js";
import {
  DEFAULTS as SVG_DEFAULTS,
  EXPRESSIONS,
  resolveColor,
  resolveInk,
  resolveTheme,
} from "./avatar-engine.js";

const BODY_NAMES = {
  blob: "sphere",
  flower: "starFlower",
  heart: "heartChubby",
  star: "star6",
};

const DEFAULTS = {
  ...SVG_DEFAULTS,
  renderer: "3d",
  dragMode: "rotate",
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrapDegrees = (value) => {
  let next = value % 360;
  if (next > 180) next -= 360;
  if (next < -180) next += 360;
  return next;
};
const round2 = (value) => Math.round(value * 100) / 100;

let uidCounter = 0;

function hashSeed(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

function appearanceFor(options) {
  const theme = resolveTheme(options.theme);
  const fill = resolveColor(options.color, theme);
  const ink = options.eyeColor || resolveInk(fill);
  return {
    theme,
    fill,
    ink,
    appearance: {
      ink: [0, 0, 0],
      spot: [0, 0, 0],
      cutout: false,
      inkPaint: fill,
      spotPaint: ink,
    },
  };
}

function bodyNameFor(shape) {
  return BODY_NAMES[shape] ?? shape;
}

function expressionName(value) {
  return value && value !== "auto" && EXPRESSIONS[value] ? value : null;
}

function stillClip({ body, expression, view }) {
  const ease = [0.42, 0, 0.58, 1];
  const tracks = {
    rotation: [
      {
        t: 0,
        v: [view.pitch, view.yaw, view.roll],
        ease,
      },
    ],
    position: [{ t: 0, v: [0, 0], ease }],
    squash: [{ t: 0, v: [1, 1], ease }],
  };
  const face = expressionName(expression);
  if (face) {
    tracks.expression = [{ t: 0, v: face, ease }];
  }
  return {
    name: "Still",
    duration: 1,
    body,
    squashAnchor: 0,
    workArea: { start: 0, end: 1 },
    inspect: {},
    tracks,
  };
}

class AgentAvatar3DEngine {
  constructor(host, options = {}) {
    this.host = host;
    this.options = { ...DEFAULTS, ...options };
    this.id = `avatar-3d-${(uidCounter += 1)}`;
    this.state = this.options.state ?? "idle";
    this.expression = this.options.expression ?? "auto";
    this.view = { yaw: 0, pitch: 0, roll: 0 };
    this.core = null;
    this.canvas = null;
    this.cleanup = null;
    this.drag = null;
    this.inertiaFrame = 0;
    this.destroyed = false;
    this.seed = hashSeed(
      `${this.options.shape}:${this.options.color}:${this.options.theme}`,
    );
    this.boundPointerDown = this.onPointerDown.bind(this);
    this.boundPointerMove = this.onPointerMove.bind(this);
    this.boundPointerUp = this.onPointerUp.bind(this);
    this.boundClick = this.onClick.bind(this);
    this.build();
  }

  build() {
    const { host } = this;
    host.classList.add("aa3d-root");
    host.dataset.renderer = "3d";
    host.dataset.state = this.state;
    host.setAttribute("role", "img");
    host.setAttribute("aria-label", this.options.ariaLabel ?? "智能体头像");
    host.setAttribute(
      "tabindex",
      this.options.interactive === false ? "-1" : "0",
    );
    this.applySize();

    this.canvas = host.ownerDocument.createElement("span");
    this.canvas.className = "aa3d-canvas";
    this.canvas.style.cssText =
      "display:block;width:100%;height:100%;overflow:visible;pointer-events:none";
    host.appendChild(this.canvas);

    this.core = createAvatarEngine(this.coreOptions());
    this.cleanup = this.core.attach({ host, canvas: this.canvas });

    host.addEventListener("pointerdown", this.boundPointerDown);
    host.addEventListener("pointermove", this.boundPointerMove, {
      passive: true,
    });
    host.addEventListener("pointerup", this.boundPointerUp);
    host.addEventListener("pointercancel", this.boundPointerUp);
    host.addEventListener("click", this.boundClick);
    this.applyExpression();
  }

  applySize() {
    const size = this.options.size;
    if (typeof size === "number") {
      this.host.style.width = `${size}px`;
      this.host.style.height = `${size}px`;
    } else if (typeof size === "string") {
      this.host.style.width = size;
      this.host.style.height = size;
    }
  }

  coreOptions() {
    const { appearance } = appearanceFor(this.options);
    const size =
      typeof this.options.size === "number" ? this.options.size : 320;
    const pixelRatio =
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const resolution = clamp(
      Math.round(size * Math.max(1, pixelRatio)),
      128,
      1024,
    );
    return {
      id: this.id,
      body: bodyNameFor(this.options.shape ?? "blob"),
      appearance,
      state: this.state,
      clip: null,
      morph: null,
      size,
      resolution,
      maxFrameRate: 60,
      isPlaying: !this.options.paused && !this.options.reducedMotion,
      isEmphasized: (this.options.intensity ?? 1) > 1.15,
      isFollowingPointer: Boolean(
        this.options.followPointer || this.options.hoverTilt,
      ),
      isStatic: false,
      isProof: false,
      view: this.view,
      seed: this.seed,
    };
  }

  update(next = {}) {
    if (this.destroyed) return;
    const previous = this.options;
    this.options = { ...this.options, ...next };
    const changed = (key) => !Object.is(previous[key], this.options[key]);

    if (
      changed("shape") ||
      changed("color") ||
      changed("theme") ||
      changed("eyeColor")
    ) {
      this.seed = hashSeed(
        `${this.options.shape}:${this.options.color}:${this.options.theme}`,
      );
    }

    if (changed("size")) this.applySize();
    if (changed("state")) {
      this.state = this.options.state ?? "idle";
      this.host.dataset.state = this.state;
      this.core.setState(this.state);
    }

    if (changed("expression")) {
      this.expression = this.options.expression ?? "auto";
      this.applyExpression();
    }

    if (changed("paused") || changed("reducedMotion")) {
      this.core.setPlaying(
        !this.options.paused && !this.options.reducedMotion,
      );
    }

    this.core.update(this.coreOptions());
  }

  applyExpression() {
    if (!this.core) return;
    if (expressionName(this.expression)) {
      this.core.setExpression(this.expression);
    } else {
      this.core.clearFace();
    }
  }

  setState(state) {
    if (this.destroyed) return;
    this.state = state;
    this.options.state = state;
    this.host.dataset.state = state;
    this.core.setState(state);
    if (expressionName(this.expression)) {
      this.core.setExpression(this.expression);
    }
  }

  setExpression(expression) {
    if (this.destroyed) return;
    this.expression = expression;
    this.options.expression = expression;
    this.applyExpression();
  }

  poke(action = "bounce", options = {}) {
    if (this.destroyed) return;
    const resolved =
      action === "random"
        ? ["spin", "bounce", "nod"][Math.floor(Math.random() * 3)]
        : action;
    this.core.poke(resolved, options);
  }

  gazeTo(vector = { x: 0, y: 0 }) {
    if (this.destroyed) return;
    this.core.gaze([
      clamp(vector.x ?? 0, -1, 1),
      clamp(vector.y ?? 0, -1, 1),
    ]);
  }

  setView(view = {}) {
    if (this.destroyed) return;
    if (typeof this.core?.setView !== "function") {
      console.warn("avatar-3d core has no setView", this.core);
      return;
    }
    const next = {
      yaw: wrapDegrees(view.yaw ?? this.view.yaw),
      pitch: clamp(view.pitch ?? this.view.pitch, -85, 85),
      roll: wrapDegrees(view.roll ?? this.view.roll),
    };
    this.view = next;
    this.core.setView(next);
    this.host.dataset.view = `${round2(next.yaw)} ${round2(next.pitch)}`;
  }

  resetView() {
    this.setView({ yaw: 0, pitch: 0, roll: 0 });
  }

  onPointerDown(event) {
    if (
      this.options.draggable === false ||
      this.options.interactive === false ||
      event.button !== 0
    ) {
      return;
    }
    this.stopInertia();
    event.preventDefault();
    this.host.setPointerCapture?.(event.pointerId);
    this.host.classList.add("aa-is-dragging");
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastTime: performance.now(),
      startView: { ...this.view },
      velocityX: 0,
      velocityY: 0,
      moved: false,
    };
  }

  onPointerMove(event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastTime);
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.velocityX = (dx / dt) * 1000;
    drag.velocityY = (dy / dt) * 1000;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.lastTime = now;
    const totalX = event.clientX - drag.startX;
    const totalY = event.clientY - drag.startY;
    if (Math.hypot(totalX, totalY) > 3) drag.moved = true;
    this.setView({
      yaw: drag.startView.yaw + totalX * 0.55,
      pitch: drag.startView.pitch - totalY * 0.45,
      roll: drag.startView.roll,
    });
  }

  onPointerUp(event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.host.releasePointerCapture?.(event.pointerId);
    this.host.classList.remove("aa-is-dragging");
    this.drag = null;
    if (drag.moved) {
      this.startInertia(drag.velocityX * 0.42, -drag.velocityY * 0.34);
    }
  }

  onClick() {
    if (this.options.interactive === false) return;
    if (this.drag?.moved) return;
    const action = this.options.clickAction ?? "bounce";
    this.poke(action);
    this.options.onPoke?.(action);
  }

  startInertia(velocityX, velocityY) {
    this.stopInertia();
    if (Math.abs(velocityX) < 4 && Math.abs(velocityY) < 4) return;
    let previous = performance.now();
    const step = (now) => {
      const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
      previous = now;
      velocityX *= 0.92;
      velocityY *= 0.92;
      this.setView({
        yaw: this.view.yaw + velocityX * dt,
        pitch: this.view.pitch + velocityY * dt,
        roll: this.view.roll,
      });
      if (Math.abs(velocityX) > 0.6 || Math.abs(velocityY) > 0.6) {
        this.inertiaFrame = requestAnimationFrame(step);
      } else {
        this.inertiaFrame = 0;
      }
    };
    this.inertiaFrame = requestAnimationFrame(step);
  }

  stopInertia() {
    if (this.inertiaFrame) cancelAnimationFrame(this.inertiaFrame);
    this.inertiaFrame = 0;
  }

  getStaticSvg(size = 512) {
    if (typeof document === "undefined") return "";
    const { theme, appearance } = appearanceFor(this.options);
    const body = bodyNameFor(this.options.shape ?? "blob");
    const stillId = `${this.id}-still-${(uidCounter += 1)}`;
    const host = document.createElement("div");
    host.style.cssText =
      "position:absolute;left:-10000px;top:-10000px;width:" +
      size +
      "px;height:" +
      size +
      "px;pointer-events:none";
    const canvas = document.createElement("span");
    canvas.style.cssText = "display:block;width:100%;height:100%";
    host.appendChild(canvas);
    document.body.appendChild(host);
    let cleanup = null;
    try {
      const core = createAvatarEngine({
        id: stillId,
        body,
        appearance,
        state: undefined,
        clip: stillClip({
          body,
          expression: this.expression,
          view: this.view,
        }),
        morph: null,
        size,
        resolution: size,
        maxFrameRate: 60,
        isPlaying: false,
        isEmphasized: false,
        isFollowingPointer: false,
        isStatic: true,
        isProof: false,
        view: this.view,
        seed: this.seed,
      });
      cleanup = core.attach({ host, canvas });
      const svg = canvas.querySelector("svg");
      if (!svg) return "";
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
      svg.setAttribute("data-theme", theme);
      return svg.outerHTML;
    } finally {
      cleanup?.();
      host.remove();
    }
  }

  getPngDataUrl(size = 512) {
    if (typeof document === "undefined") return Promise.resolve("");
    const svg = this.getStaticSvg(size);
    if (!svg) return Promise.resolve("");
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) {
          resolve("");
          return;
        }
        context.clearRect(0, 0, size, size);
        context.drawImage(image, 0, 0, size, size);
        resolve(canvas.toDataURL("image/png"));
      };
      image.onerror = () => resolve("");
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
  }

  start() {
    this.update({ paused: false });
  }

  stop() {
    this.update({ paused: true });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopInertia();
    this.host.removeEventListener("pointerdown", this.boundPointerDown);
    this.host.removeEventListener("pointermove", this.boundPointerMove);
    this.host.removeEventListener("pointerup", this.boundPointerUp);
    this.host.removeEventListener("pointercancel", this.boundPointerUp);
    this.host.removeEventListener("click", this.boundClick);
    this.cleanup?.();
    this.cleanup = null;
    this.canvas?.remove();
    this.canvas = null;
    this.core = null;
    this.host.classList.remove("aa3d-root", "aa-is-dragging");
  }
}

export { AgentAvatar3DEngine, DEFAULTS as DEFAULTS_3D, BODY_NAMES };
