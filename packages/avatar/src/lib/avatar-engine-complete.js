/**
 * Botform Avatar Complete Engine
 *
 * The faithful flat/stem renderer: exact palette fill, the full state clip
 * library, eye expressions, gaze and poke actions, and every morph effect.
 * It is independent from the 3D view renderer.
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
  renderer: "complete",
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

let uidCounter = 0;

function hashSeed(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

function bodyNameFor(shape) {
  return BODY_NAMES[shape] ?? shape;
}

function expressionName(value) {
  return value && value !== "auto" && EXPRESSIONS[value] ? value : null;
}

function appearanceFor(options) {
  const theme = resolveTheme(options.theme);
  const fill = resolveColor(options.color, theme);
  const ink = options.eyeColor || resolveInk(fill);
  return {
    theme,
    appearance: {
      ink: [0, 0, 0],
      spot: [0, 0, 0],
      cutout: false,
      inkPaint: fill,
      spotPaint: ink,
    },
  };
}

function stillClip({ body, expression }) {
  const ease = [0.42, 0, 0.58, 1];
  const tracks = {
    rotation: [{ t: 0, v: [0, 0, 0], ease }],
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

class AgentAvatarCompleteEngine {
  constructor(host, options = {}) {
    this.host = host;
    this.options = { ...DEFAULTS, ...options };
    this.id = `avatar-complete-${(uidCounter += 1)}`;
    this.state = this.options.state ?? "idle";
    this.expression = this.options.expression ?? "auto";
    this.core = null;
    this.canvas = null;
    this.cleanup = null;
    this.destroyed = false;
    this.seed = hashSeed(
      `${this.options.shape}:${this.options.color}:${this.options.theme}`,
    );
    this.boundClick = this.onClick.bind(this);
    this.build();
  }

  build() {
    const { host } = this;
    host.classList.add("aa-complete-root");
    host.dataset.renderer = "complete";
    host.dataset.state = this.state;
    host.setAttribute("role", "img");
    host.setAttribute("aria-label", this.options.ariaLabel ?? "智能体头像");
    host.setAttribute(
      "tabindex",
      this.options.interactive === false ? "-1" : "0",
    );
    this.applySize();

    this.canvas = host.ownerDocument.createElement("span");
    this.canvas.className = "aa-complete-canvas";
    this.canvas.style.cssText =
      "display:block;width:100%;height:100%;overflow:visible;pointer-events:none";
    host.appendChild(this.canvas);

    this.core = createAvatarEngine(this.coreOptions());
    this.cleanup = this.core.attach({ host, canvas: this.canvas });
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

  onClick() {
    if (this.options.interactive === false) return;
    const action = this.options.clickAction ?? "bounce";
    this.poke(action);
    this.options.onPoke?.(action);
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
      const face = expressionName(this.expression);
      const core = createAvatarEngine({
        id: stillId,
        body,
        appearance,
        state: face ? undefined : this.state,
        clip: face ? stillClip({ body, expression: face }) : null,
        morph: null,
        size,
        resolution: size,
        maxFrameRate: 60,
        isPlaying: false,
        isEmphasized: false,
        isFollowingPointer: false,
        isStatic: true,
        isProof: false,
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
    this.host.removeEventListener("click", this.boundClick);
    this.cleanup?.();
    this.cleanup = null;
    this.canvas?.remove();
    this.canvas = null;
    this.core = null;
    this.host.classList.remove("aa-complete-root");
  }
}

export { AgentAvatarCompleteEngine, DEFAULTS as DEFAULTS_COMPLETE, BODY_NAMES };
