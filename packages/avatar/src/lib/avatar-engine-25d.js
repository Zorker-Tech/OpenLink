/**
 * Botform Avatar 2.5D Engine
 *
 * A layered pseudo-3D renderer. The silhouette is repeated across a depth
 * range, each slice is projected through the same yaw / pitch / roll matrix,
 * and the slices are composited back-to-front. The result is a lightweight
 * SVG object with real side walls, end caps, depth shading and pointer-driven
 * rotation instead of a flat card rotated by CSS.
 */

import {
  AUTO_NEXT,
  DEFAULTS as SVG_DEFAULTS,
  EXPRESSIONS,
  STATE_EFFECTS,
  STATE_EXPRESSION,
  STATE_MOTION,
  effectLayer,
  eyeMarkup,
  getShape,
  resolveColor,
  resolveInk,
  resolveTheme,
} from "./avatar-engine.js";

const L = 114.2705;
const TAU = Math.PI * 2;
const VIEWBOX = "-48 -48 324.541 324.541";
const BASE_YAW = -0.34;
const BASE_PITCH = 0.13;
const LIGHT_X = -0.56;
const LIGHT_Y = -0.83;

const DEFAULTS = {
  ...SVG_DEFAULTS,
  renderer: "25d",
  thickness: 0.62,
  layers: 36,
  sideShade: 0.58,
  perspective: 0.42,
  facetLines: false,
  dragMode: "rotate",
  maxPitch: 72,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (a, b, t) => a + (b - a) * t;
const round2 = (value) => Math.round(value * 100) / 100;
const degToRad = (degrees) => (degrees * Math.PI) / 180;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function parseColor(color) {
  if (typeof color !== "string") return null;
  const value = color.trim();
  if (value.startsWith("#")) {
    let hex = value.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((char) => char + char)
        .join("");
    }
    if (hex.length !== 6) return null;
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }
  const match = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return null;
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((part) => Number.parseFloat(part));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  return [parts[0], parts[1], parts[2]];
}

function rgbToHex(rgb) {
  return `#${rgb
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixRgb(a, b, amount) {
  return a.map((value, index) => value + (b[index] - value) * amount);
}

function shadeColor(color, amount) {
  const rgb = parseColor(color);
  if (!rgb) return color;
  if (amount >= 0) {
    return rgbToHex(mixRgb(rgb, [255, 255, 255], clamp(amount, 0, 1)));
  }
  return rgbToHex(mixRgb(rgb, [0, 0, 0], clamp(-amount, 0, 1)));
}

function alphaColor(color, alpha) {
  const rgb = parseColor(color);
  if (!rgb) return color;
  return `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(
    rgb[2],
  )}, ${clamp(alpha, 0, 1)})`;
}

function rotatePoint(x, y, z, yaw, pitch, roll) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const x1 = x * cy + z * sy;
  const y1 = y;
  const z1 = -x * sy + z * cy;
  const x2 = x1;
  const y2 = y1 * cp - z1 * sp;
  const z2 = y1 * sp + z1 * cp;
  const x3 = x2 * cr - y2 * sr;
  const y3 = x2 * sr + y2 * cr;
  return { x: x3, y: -y3, z: z2 };
}

function projectionFor(yaw, pitch, roll) {
  const ex = rotatePoint(1, 0, 0, yaw, pitch, roll);
  const ey = rotatePoint(0, 1, 0, yaw, pitch, roll);
  const ez = rotatePoint(0, 0, 1, yaw, pitch, roll);
  return {
    a: ex.x,
    b: ex.y,
    c: ey.x,
    d: ey.y,
    vzx: ez.x,
    vzy: ez.y,
    normalZ: ez.z,
  };
}

function layerTransform(z, halfDepth, projection, perspective) {
  const depthRatio =
    halfDepth > 0 ? (z * projection.normalZ) / halfDepth : 0;
  const scale = 1 + depthRatio * perspective * 0.16;
  const a = projection.a * scale;
  const b = projection.b * scale;
  const c = projection.c * scale;
  const d = projection.d * scale;
  const e = L + z * projection.vzx;
  const f = L + z * projection.vzy;
  return `matrix(${round2(a * 1000) / 1000} ${round2(b * 1000) / 1000} ${round2(
    c * 1000,
  ) / 1000} ${round2(d * 1000) / 1000} ${round2(e)} ${round2(f)}) translate(${-L} ${-L})`;
}

function createSvgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}

function pumpkinStem() {
  return `<path d="M${L - 8} ${L - 94} C${L - 10} ${L - 116}, ${L + 8} ${L - 122}, ${
    L + 14
  } ${L - 132} L${L + 28} ${L - 126} C${L + 20} ${L - 112}, ${L + 18} ${L - 100}, ${
    L + 14
  } ${L - 90} Z" fill="#5B7C2E" />`;
}

class AgentAvatar25DEngine {
  constructor(host, options = {}) {
    if (!host) throw new Error("AgentAvatar25DEngine requires a host element");
    this.host = host;
    this.options = { ...DEFAULTS, ...options };
    this.uid = `aa25-${Math.random().toString(36).slice(2, 9)}`;
    this.t = 0;
    this.lastFrame = 0;
    this.gaze = { x: 0, y: 0 };
    this.targetGaze = { x: 0, y: 0 };
    this.pokes = [];
    this.dragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.manualYaw = 0;
    this.manualPitch = 0;
    this.manualRoll = 0;
    this.manualVelocityYaw = 0;
    this.manualVelocityPitch = 0;
    this.pointerDown = null;
    this.lastPointer = null;
    this.hovering = false;
    this.blinkStart = -1;
    this.nextBlinkAt = 2.2 + Math.random() * 2.8;
    this.stateStartedAt = 0;
    this.raf = 0;
    this.isDestroyed = false;
    this.view = { yaw: BASE_YAW, pitch: BASE_PITCH, roll: 0 };
    this.projection = projectionFor(BASE_YAW, BASE_PITCH, 0);
    this.layerEntries = [];
    this.sliceBasePaths = [];
    this.orderFront = true;
    this.shadeLut = [];
    this.boundFrame = this.frame.bind(this);
    this.boundPointerMove = this.onPointerMove.bind(this);
    this.boundPointerDown = this.onPointerDown.bind(this);
    this.boundPointerUp = this.onPointerUp.bind(this);
    this.boundPointerLeave = this.onPointerLeave.bind(this);
    this.boundWindowPointerMove = this.onWindowPointerMove.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
    this.setup();
    this.attach();
    this.start();
  }

  get shapeId() {
    return getShape(this.options.shape ?? "blob").id;
  }

  get state() {
    return STATE_EXPRESSION[this.options.state] ? this.options.state : "idle";
  }

  get theme() {
    return resolveTheme(this.options.theme);
  }

  get colorValue() {
    return resolveColor(this.options.color, this.theme);
  }

  get inkValue() {
    return this.options.eyeColor
      ? this.options.eyeColor
      : resolveInk(this.colorValue);
  }

  get expressionName() {
    if (this.options.expression && this.options.expression !== "auto") {
      return EXPRESSIONS[this.options.expression]
        ? this.options.expression
        : "neutral";
    }
    return STATE_EXPRESSION[this.state] ?? "neutral";
  }

  get effectColor() {
    const ink = this.inkValue;
    if (this.theme === "dark") {
      return ink === "#111111" ? "#ECECEC" : ink;
    }
    return ink === "#FFFFFF" ? "#1A1A1A" : ink;
  }

  get sizeValue() {
    return typeof this.options.size === "number"
      ? `${this.options.size}px`
      : this.options.size;
  }

  get halfDepth() {
    return clamp(this.options.thickness ?? 0.62, 0.18, 1.15) * 75;
  }

  get layerCount() {
    return Math.round(clamp(this.options.layers ?? 36, 10, 72));
  }

  setup() {
    this.host.classList.add("aa-root", "aa25-root");
    this.host.innerHTML = "";
    this.host.style.setProperty("--aa-size", this.sizeValue);
    this.host.style.setProperty("--aa-color", this.colorValue);
    this.host.style.setProperty("--aa-ink", this.inkValue);
    this.host.style.setProperty("--aa-effect", this.effectColor);
    this.host.style.setProperty("--aa-depth", String(clamp(this.options.depth, 0, 1)));
    this.host.style.setProperty("--aa-glow", String(clamp(this.options.glow, 0, 1)));
    this.host.style.setProperty("--aa-blink", "1");
    this.host.style.setProperty("--aa-eye-x", "0px");
    this.host.style.setProperty("--aa-eye-y", "0px");
    this.host.style.setProperty("--aa-bang-ink", resolveInk(this.inkValue));
    this.host.style.setProperty("--aa-notify", "#FF4D4D");
    this.host.tabIndex = this.options.interactive ? 0 : -1;
    this.host.setAttribute("role", "button");
    this.host.setAttribute("aria-label", this.options.ariaLabel ?? "智能体头像");
    this.host.setAttribute("data-theme", this.theme);
    this.host.setAttribute("data-renderer", "25d");

    this.glow = document.createElement("div");
    this.glow.className = "aa-glow";
    this.glow.setAttribute("aria-hidden", "true");
    this.host.appendChild(this.glow);

    this.shadow = document.createElement("div");
    this.shadow.className = "aa-ground-shadow";
    this.shadow.setAttribute("aria-hidden", "true");
    this.host.appendChild(this.shadow);

    this.halo = document.createElement("div");
    this.halo.className = "aa-halo";
    this.halo.setAttribute("aria-hidden", "true");
    this.halo.style.display = this.options.ring ? "block" : "none";
    this.host.appendChild(this.halo);

    const svgMarkup = `
      <svg class="aa-svg aa25-svg" viewBox="${VIEWBOX}" xmlns="http://www.w3.org/2000/svg" overflow="visible" aria-hidden="true">
        <defs>
          <linearGradient id="${this.uid}-side" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity=".34"/>
            <stop offset="46%" stop-color="#FFFFFF" stop-opacity=".04"/>
            <stop offset="100%" stop-color="#000000" stop-opacity=".3"/>
          </linearGradient>
          <linearGradient id="${this.uid}-face" x1="0.1" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity=".22"/>
            <stop offset="48%" stop-color="#FFFFFF" stop-opacity=".02"/>
            <stop offset="100%" stop-color="#000000" stop-opacity=".18"/>
          </linearGradient>
          <radialGradient id="${this.uid}-sheen" cx="34%" cy="24%" r="74%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity=".62"/>
            <stop offset="36%" stop-color="#FFFFFF" stop-opacity=".2"/>
            <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="${this.uid}-shade" cx="72%" cy="82%" r="74%">
            <stop offset="0%" stop-color="#000000" stop-opacity=".3"/>
            <stop offset="56%" stop-color="#000000" stop-opacity=".1"/>
            <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
          </radialGradient>
          <linearGradient id="${this.uid}-back" x1="0.2" y1="0" x2="0.8" y2="1">
            <stop offset="0%" stop-color="#000000" stop-opacity=".16"/>
            <stop offset="100%" stop-color="#000000" stop-opacity=".46"/>
          </linearGradient>
        </defs>
        <g class="aa25-world">
          <g class="aa25-body"></g>
          <g class="aa25-fx"></g>
        </g>
      </svg>
    `;
    this.host.insertAdjacentHTML("beforeend", svgMarkup);
    this.svg = this.host.querySelector(".aa25-svg");
    this.worldGroup = this.host.querySelector(".aa25-world");
    this.bodyGroup = this.host.querySelector(".aa25-body");
    this.effectsGroup = this.host.querySelector(".aa25-fx");

    this.renderBody();
    this.renderEffects();
    this.updateColors();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.paintFrame();
  }

  renderBody() {
    if (!this.bodyGroup) return;
    this.bodyGroup.innerHTML = "";
    this.layerEntries = [];
    this.sliceBasePaths = [];
    this.orderFront = true;

    const shape = getShape(this.shapeId);
    const half = this.halfDepth;
    const count = this.layerCount;

    const backCap = createSvgElement("g", { class: "aa25-back" });
    const backFill = createSvgElement("path", {
      d: shape.path,
      fill: "url(#" + this.uid + "-back)",
      class: "aa25-back-fill",
    });
    const backRim = createSvgElement("path", {
      d: shape.path,
      fill: "none",
      stroke: "rgba(0,0,0,.24)",
      "stroke-width": "1.1",
    });
    backCap.append(backFill, backRim);
    this.backCap = backCap;
    this.layerEntries.push({ el: backCap, z: -half, kind: "back" });

    const step = count > 1 ? (half * 2) / (count - 1) : 0;
    for (let index = 0; index < count; index += 1) {
      const z = -half + step * index;
      const slice = createSvgElement("g", { class: "aa25-slice" });
      const base = createSvgElement("path", {
        d: shape.path,
        fill: this.shadeLut[Math.floor(this.shadeLut.length / 2)] ?? this.colorValue,
        stroke: this.colorValue,
        "stroke-width": "0.7",
        "stroke-linejoin": "round",
        class: "aa25-slice-base",
      });
      const overlay = createSvgElement("path", {
        d: shape.path,
        fill: `url(#${this.uid}-side)`,
        class: "aa25-slice-overlay",
      });
      const facet = createSvgElement("path", {
        d: shape.path,
        fill: "none",
        stroke: "var(--aa-ink)",
        "stroke-width": "0.55",
        "stroke-opacity": "0.13",
        class: "aa25-facet",
      });
      slice.append(base, overlay, facet);
      this.bodyGroup.appendChild(slice);
      this.sliceBasePaths.push(base);
      this.layerEntries.push({ el: slice, z, kind: "slice" });
    }

    const frontCap = createSvgElement("g", { class: "aa25-front" });
    const faceFill = createSvgElement("path", {
      d: shape.path,
      fill: this.colorValue,
      class: "aa25-face-fill",
    });
    const faceGradient = createSvgElement("path", {
      d: shape.path,
      fill: `url(#${this.uid}-face)`,
      class: "aa25-face-gradient",
    });
    const sheen = createSvgElement("path", {
      d: shape.path,
      fill: `url(#${this.uid}-sheen)`,
      class: "aa25-face-sheen",
    });
    const shade = createSvgElement("path", {
      d: shape.path,
      fill: `url(#${this.uid}-shade)`,
      class: "aa25-face-shade",
    });
    const rim = createSvgElement("path", {
      d: shape.path,
      fill: "none",
      stroke: "rgba(255,255,255,.4)",
      "stroke-width": "1.15",
      class: "aa25-face-rim",
    });
    const stem = createSvgElement("g", { class: "aa25-stem" });
    if (this.shapeId === "pumpkin") {
      stem.innerHTML = pumpkinStem();
    }
    const eyes = createSvgElement("g", { class: "aa25-eyes aa-eyes" });
    this.eyesGroup = eyes;
    this.faceOverlayGroup = createSvgElement("g", { class: "aa25-face-overlay" });
    this.faceOverlayGroup.append(sheen, shade, rim, stem);
    frontCap.append(faceFill, faceGradient, this.faceOverlayGroup, eyes);
    this.frontCap = frontCap;
    this.faceFill = faceFill;
    this.layerEntries.push({ el: frontCap, z: half, kind: "front" });
    this.bodyGroup.appendChild(frontCap);
    this.renderEyes();
    this.updateColors();
  }

  renderEyes() {
    if (!this.eyesGroup) return;
    const shape = getShape(this.shapeId);
    this.eyesGroup.innerHTML = eyeMarkup(
      this.expressionName,
      shape,
      this.options,
    );
  }

  renderEffects() {
    if (!this.effectsGroup) return;
    this.effectsGroup.innerHTML = "";
    const types = this.options.effects
      ? STATE_EFFECTS[this.state] ?? []
      : [];
    for (const className of [...this.host.classList]) {
      if (className.startsWith("aa-show-")) {
        this.host.classList.remove(className);
      }
    }
    for (const type of types) {
      this.host.classList.add(`aa-show-${type}`);
    }
    if (!this.options.effects) {
      this.progressArc = null;
      return;
    }
    this.effectsGroup.innerHTML = effectLayer();
    this.progressArc = this.effectsGroup.querySelector(".aa-progress-arc");
  }

  updateColors() {
    if (!this.host) return;
    const color = this.colorValue;
    const ink = this.inkValue;
    const effect = this.effectColor;
    this.host.style.setProperty("--aa-color", color);
    this.host.style.setProperty("--aa-ink", ink);
    this.host.style.setProperty("--aa-effect", effect);
    this.host.style.setProperty("--aa-depth", String(clamp(this.options.depth, 0, 1)));
    this.host.style.setProperty("--aa-glow", String(clamp(this.options.glow, 0, 1)));
    this.host.style.setProperty("--aa-bang-ink", resolveInk(ink));
    this.host.setAttribute("data-theme", this.theme);

    const side = this.svg?.querySelector(`#${this.uid}-side`);
    if (side) {
      const stops = side.querySelectorAll("stop");
      const strength = clamp(this.options.sideShade ?? 0.58, 0, 1);
      stops[0]?.setAttribute("stop-color", shadeColor(color, 0.5 * strength));
      stops[0]?.setAttribute("stop-opacity", String(0.3 + strength * 0.16));
      stops[1]?.setAttribute("stop-color", color);
      stops[1]?.setAttribute("stop-opacity", "0.02");
      stops[2]?.setAttribute("stop-color", shadeColor(color, -0.72 * strength));
      stops[2]?.setAttribute("stop-opacity", String(0.26 + strength * 0.2));
    }
    const face = this.svg?.querySelector(`#${this.uid}-face`);
    if (face) {
      const stops = face.querySelectorAll("stop");
      stops[0]?.setAttribute("stop-color", shadeColor(color, 0.34));
      stops[0]?.setAttribute("stop-opacity", "0.24");
      stops[1]?.setAttribute("stop-color", color);
      stops[1]?.setAttribute("stop-opacity", "0.02");
      stops[2]?.setAttribute("stop-color", shadeColor(color, -0.42));
      stops[2]?.setAttribute("stop-opacity", "0.2");
    }
    if (this.faceFill) {
      this.faceFill.setAttribute("fill", color);
    }
    if (this.backCap) {
      const back = this.backCap.querySelector(".aa25-back-fill");
      back?.setAttribute("fill", shadeColor(color, -0.22));
      const backRim = this.backCap.querySelector("path:last-child");
      backRim?.setAttribute("stroke", alphaColor(shadeColor(color, 0.38), 0.24));
    }
    if (this.faceOverlayGroup) {
      const rim = this.faceOverlayGroup.querySelector(".aa25-face-rim");
      rim?.setAttribute("stroke", alphaColor(shadeColor(color, 0.72), 0.46));
    }
    this.shadeLut = [];
    for (let index = 0; index < 48; index += 1) {
      const amount = -0.3 + (index / 47) * 0.6;
      this.shadeLut.push(shadeColor(color, amount));
    }
    if (this.sliceBasePaths.length) {
      const mid = this.shadeLut[Math.floor(this.shadeLut.length / 2)];
      for (const path of this.sliceBasePaths) {
        path.setAttribute("fill", mid);
        path.setAttribute("stroke", mid);
      }
    }
  }

  update(next = {}) {
    const previous = this.options;
    const merged = { ...previous, ...next };
    const shapeChanged =
      merged.shape !== previous.shape ||
      merged.thickness !== previous.thickness ||
      merged.layers !== previous.layers;
    const colorChanged =
      merged.color !== previous.color ||
      merged.theme !== previous.theme ||
      merged.eyeColor !== previous.eyeColor ||
      merged.sideShade !== previous.sideShade;
    const expressionChanged =
      merged.state !== previous.state ||
      merged.expression !== previous.expression ||
      merged.eyeColor !== previous.eyeColor ||
      merged.eyeY !== previous.eyeY ||
      shapeChanged;
    const effectsChanged =
      merged.state !== previous.state ||
      merged.effects !== previous.effects ||
      colorChanged;
    this.options = merged;
    if (merged.state !== previous.state) {
      this.stateStartedAt = this.t;
      this.options.onStateChange?.(merged.state);
    }
    if (shapeChanged) {
      this.renderBody();
    }
    if (colorChanged) {
      this.updateColors();
    }
    if (expressionChanged && !shapeChanged) {
      this.renderEyes();
    }
    if (effectsChanged) {
      this.renderEffects();
    }
    if (merged.ring !== previous.ring) {
      this.halo.style.display = merged.ring ? "block" : "none";
    }
    if (merged.shadow !== previous.shadow) {
      this.shadow.style.display = merged.shadow === false ? "none" : "block";
    }
    if (merged.facetLines !== previous.facetLines) {
      this.host.classList.toggle("aa25-facets", Boolean(merged.facetLines));
    }
    if (merged.paused !== previous.paused) {
      this.host.classList.toggle("aa-paused", Boolean(merged.paused));
    }
    if (merged.reducedMotion !== previous.reducedMotion) {
      this.host.classList.toggle("aa-reduced", Boolean(merged.reducedMotion));
    }
    this.host.style.setProperty("--aa-size", this.sizeValue);
    this.host.tabIndex = this.options.interactive ? 0 : -1;
    this.host.setAttribute("aria-label", this.options.ariaLabel ?? "智能体头像");
    this.detach();
    this.attach();
    this.resize();
    this.applyMotion(0);
  }

  setState(state) {
    if (state === this.state) return;
    this.options.state = state;
    this.stateStartedAt = this.t;
    this.renderEyes();
    this.renderEffects();
    this.options.onStateChange?.(state);
  }

  setExpression(expression) {
    if (expression === this.options.expression) return;
    this.options.expression = expression;
    this.renderEyes();
  }

  poke(action = "bounce", options = {}) {
    let resolved = action;
    if (resolved === "random") {
      resolved = ["spin", "bounce", "nod"][Math.floor(Math.random() * 3)];
    }
    if (!["spin", "bounce", "nod"].includes(resolved)) return;
    this.pokes.push({
      action: resolved,
      start: this.t,
      duration:
        resolved === "spin" ? 0.9 : resolved === "bounce" ? 0.62 : 0.5,
      turns: options.turns ?? 1,
    });
    this.options.onPoke?.(resolved);
  }

  gazeTo(vector) {
    this.targetGaze = {
      x: clamp(vector?.x ?? 0, -1, 1),
      y: clamp(vector?.y ?? 0, -1, 1),
    };
  }

  resetView() {
    this.manualYaw = 0;
    this.manualPitch = 0;
    this.manualRoll = 0;
    this.manualVelocityYaw = 0;
    this.manualVelocityPitch = 0;
    this.dragOffset = { x: 0, y: 0 };
    this.applyMotion(0);
  }

  setView(view = {}) {
    if (Number.isFinite(view.yaw)) {
      this.manualYaw = degToRad(view.yaw) - BASE_YAW;
      this.manualVelocityYaw = 0;
    }
    if (Number.isFinite(view.pitch)) {
      this.manualPitch =
        degToRad(clamp(view.pitch, -this.options.maxPitch, this.options.maxPitch)) -
        BASE_PITCH;
      this.manualVelocityPitch = 0;
    }
    if (Number.isFinite(view.roll)) {
      this.manualRoll = degToRad(view.roll);
    }
    this.gaze = { x: 0, y: 0 };
    this.targetGaze = { x: 0, y: 0 };
    this.hovering = false;
    this.applyMotion(0);
  }

  start() {
    if (this.raf) return;
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.boundFrame);
  }

  stop() {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy() {
    this.isDestroyed = true;
    this.stop();
    this.detach();
    this.resizeObserver?.disconnect();
    this.host.innerHTML = "";
    this.host.classList.remove("aa-root", "aa25-root", "aa25-facets");
  }

  frame(now) {
    if (this.isDestroyed) return;
    const seconds = now / 1000;
    const dt =
      this.lastFrame === 0
        ? 0.016
        : clamp(seconds - this.lastFrame, 0.001, 0.05);
    this.lastFrame = seconds;
    if (!this.options.paused) {
      this.t += dt * clamp(this.options.speed ?? 1, 0.1, 3);
      this.updateGaze(dt);
      this.updateBlink(dt);
      this.updatePokes();
      this.updateAutoAdvance();
      this.applyMotion(dt);
    }
    this.raf = requestAnimationFrame(this.boundFrame);
  }

  updateGaze(dt) {
    if (!this.hovering && !this.dragging && !this.options.followPointer) {
      this.targetGaze = {
        x: Math.sin(this.t * 0.55) * 0.18,
        y: Math.cos(this.t * 0.42) * 0.1,
      };
    }
    const smoothing = this.options.reducedMotion
      ? 1
      : 1 - Math.exp(-dt * 10);
    this.gaze.x = lerp(this.gaze.x, this.targetGaze.x, smoothing);
    this.gaze.y = lerp(this.gaze.y, this.targetGaze.y, smoothing);
  }

  updateBlink() {
    if (!this.options.autoBlink || this.options.reducedMotion) {
      this.host.style.setProperty("--aa-blink", "1");
      return;
    }
    if (["sleeping", "drowsy", "bored"].includes(this.state)) {
      this.host.style.setProperty("--aa-blink", "0.12");
      return;
    }
    if (this.blinkStart < 0 && this.t >= this.nextBlinkAt) {
      this.blinkStart = this.t;
    }
    if (this.blinkStart >= 0) {
      const progress = (this.t - this.blinkStart) / 0.16;
      if (progress >= 1) {
        this.blinkStart = -1;
        this.nextBlinkAt = this.t + 2.2 + Math.random() * 3.6;
        this.host.style.setProperty("--aa-blink", "1");
      } else {
        const amount = Math.sin(clamp(progress, 0, 1) * Math.PI);
        this.host.style.setProperty("--aa-blink", String(1 - amount * 0.93));
      }
    }
  }

  updatePokes() {
    this.pokes = this.pokes.filter(
      (poke) => this.t - poke.start < poke.duration + 0.1,
    );
  }

  updateAutoAdvance() {
    if (!this.options.autoAdvance) return;
    const recipe = AUTO_NEXT[this.state];
    if (!recipe) return;
    if (this.t - this.stateStartedAt >= recipe.holdSeconds) {
      this.setState(recipe.next);
    }
  }

  applyMotion(dt) {
    const motion = STATE_MOTION[this.state] ?? STATE_MOTION.idle;
    const intensity = clamp(this.options.intensity ?? 1, 0, 2);
    const gazeStrength = clamp(this.options.gazeStrength ?? 1, 0, 2);
    const idle =
      this.options.idleMotion && !this.options.reducedMotion ? 1 : 0;
    const time = this.t;
    let yaw = BASE_YAW + this.manualYaw;
    let pitch = BASE_PITCH + this.manualPitch;
    let roll = this.manualRoll;
    let tx = 0;
    let ty = 0;
    let sx = 1;
    let sy = 1;
    let opacity = 1;

    if (idle) {
      ty += Math.sin(time * 1.45) * (motion.bob ?? 1) * 0.03 * intensity;
      tx += Math.sin(time * 0.92) * (motion.sway ?? 0.4) * 0.022 * intensity;
      yaw += Math.sin(time * 0.64) * (motion.tilt ?? 0.4) * 0.04 * intensity;
      pitch += Math.sin(time * 0.78 + 1.2) * (motion.tiltX ?? 0) * 0.03 * intensity;
      roll += Math.sin(time * 0.52 + 0.6) * (motion.tilt ?? 0.4) * 0.025 * intensity;
    }
    if (this.options.hoverTilt) {
      yaw += this.gaze.x * degToRad(17) * gazeStrength;
      pitch += -this.gaze.y * degToRad(12) * gazeStrength;
      tx += this.gaze.x * 0.1 * gazeStrength;
      ty += this.gaze.y * 0.05 * gazeStrength;
    }
    if (motion.jitter) {
      tx += Math.sin(time * 23) * motion.jitter * 0.009 * intensity;
      ty += Math.cos(time * 19) * motion.jitter * 0.006 * intensity;
    }
    if (motion.shake) {
      tx += Math.sin(time * 32) * motion.shake * 0.012 * intensity;
    }
    if (motion.bounce) {
      const bounce = Math.abs(Math.sin(time * 3.1));
      ty -= bounce * 0.1 * motion.bounce * intensity;
      sx += bounce * 0.022 * motion.bounce;
      sy -= bounce * 0.032 * motion.bounce;
    }
    if (motion.breathe) {
      const breathe = Math.sin(time * 1.25) * 0.5 + 0.5;
      sx += breathe * 0.012 * motion.breathe;
      sy += breathe * 0.016 * motion.breathe;
    }
    if (motion.pulse) {
      const pulse = Math.sin(time * 2.6) * 0.5 + 0.5;
      sx += pulse * 0.016 * motion.pulse;
      sy += pulse * 0.016 * motion.pulse;
    }
    if (motion.turn) {
      yaw += Math.sin(time * 0.7) * 0.18 * motion.turn;
    }
    if (motion.spin) {
      yaw += time * 0.8 * motion.spin;
    }
    if (motion.powerDown) {
      opacity = clamp(1 - (time - this.stateStartedAt) * 0.12, 0.28, 1);
      sy *= 0.985;
    }
    if (motion.dragLean) {
      pitch += this.gaze.y * 0.08;
      yaw += this.gaze.x * 0.12;
    }

    for (const poke of this.pokes) {
      const progress = clamp((this.t - poke.start) / poke.duration, 0, 1);
      const eased = easeOutCubic(progress);
      if (poke.action === "spin") {
        yaw += TAU * poke.turns * eased;
      } else if (poke.action === "bounce") {
        const lift = Math.sin(progress * Math.PI) * 0.24;
        ty -= lift;
        const squash = Math.sin(progress * Math.PI) * 0.075;
        sx += squash;
        sy -= squash;
      } else if (poke.action === "nod") {
        pitch += Math.sin(progress * Math.PI * 2) * 0.2 * (1 - progress * 0.35);
      }
    }

    if (this.options.dragMode === "rotate") {
      if (!this.dragging) {
        this.manualYaw += this.manualVelocityYaw * dt;
        this.manualPitch += this.manualVelocityPitch * dt;
        this.manualVelocityYaw *= Math.pow(0.9, dt * 60);
        this.manualVelocityPitch *= Math.pow(0.9, dt * 60);
      }
      this.manualPitch = clamp(
        this.manualPitch,
        -degToRad(this.options.maxPitch) - BASE_PITCH,
        degToRad(this.options.maxPitch) - BASE_PITCH,
      );
    } else {
      tx += this.dragOffset.x * 0.0022;
      ty += this.dragOffset.y * 0.0022;
      if (!this.dragging) {
        this.dragOffset.x = lerp(this.dragOffset.x, 0, 0.16);
        this.dragOffset.y = lerp(this.dragOffset.y, 0, 0.16);
      }
    }

    this.view = { yaw, pitch, roll };
    this.motion = { tx, ty, sx, sy, opacity };
    this.paintFrame();
  }

  paintFrame() {
    if (!this.svg) return;
    const projection = projectionFor(
      this.view.yaw,
      this.view.pitch,
      this.view.roll,
    );
    this.projection = projection;
    const half = this.halfDepth;
    const perspective = clamp(this.options.perspective ?? 0.42, 0, 1);
    const motion = this.motion ?? { tx: 0, ty: 0, sx: 1, sy: 1, opacity: 1 };
    const faceVisibility = clamp((projection.normalZ - 0.02) / 0.24, 0, 1);
    const eyeVisibility = clamp((projection.normalZ - 0.1) / 0.28, 0, 1);
    const depthLight =
      projection.vzx * LIGHT_X + projection.vzy * LIGHT_Y;
    const shadeStrength = clamp(this.options.sideShade ?? 0.58, 0, 1);
    const lutMax = this.shadeLut.length - 1;
    const dim =
      this.state === "blocked" || this.state === "powering-down" ? 0.62 : 1;

    this.layerEntries.forEach((entry, index) => {
      entry.el.setAttribute(
        "transform",
        layerTransform(entry.z, half, projection, perspective),
      );
      if (entry.kind === "slice") {
        const base = this.sliceBasePaths[index - 1];
        if (base && lutMax >= 0) {
          const depthRatio = half > 0 ? entry.z / half : 0;
          const amount = depthRatio * depthLight * shadeStrength * 0.58;
          const lutIndex = clamp(
            Math.round(((amount + 0.3) / 0.6) * lutMax),
            0,
            lutMax,
          );
          const color = this.shadeLut[lutIndex];
          base.setAttribute("fill", color);
          base.setAttribute("stroke", color);
        }
      }
    });

    const frontFacing = projection.normalZ >= 0;
    if (frontFacing !== this.orderFront) {
      this.orderFront = frontFacing;
      const entries = frontFacing
        ? [...this.layerEntries]
        : [...this.layerEntries].reverse();
      for (const entry of entries) {
        this.bodyGroup.appendChild(entry.el);
      }
    } else if (this.bodyGroup && this.layerEntries.length) {
      const first = this.bodyGroup.firstElementChild;
      const expected = frontFacing
        ? this.layerEntries[0].el
        : this.layerEntries[this.layerEntries.length - 1].el;
      if (first !== expected) {
        const entries = frontFacing
          ? [...this.layerEntries]
          : [...this.layerEntries].reverse();
        for (const entry of entries) {
          this.bodyGroup.appendChild(entry.el);
        }
      }
    }

    if (this.faceOverlayGroup) {
      this.faceOverlayGroup.style.opacity = String(
        round2(faceVisibility * 0.96),
      );
    }
    if (this.eyesGroup) {
      const gazeX = this.gaze.x * 8 * clamp(this.options.gazeStrength ?? 1, 0, 2);
      const gazeY = -this.gaze.y * 5.5 * clamp(this.options.gazeStrength ?? 1, 0, 2);
      this.eyesGroup.setAttribute(
        "transform",
        `translate(${round2(gazeX)} ${round2(gazeY)})`,
      );
      this.eyesGroup.style.opacity = String(round2(eyeVisibility * dim));
    }
    this.svg.style.opacity = String(round2(motion.opacity));
    this.worldGroup.setAttribute(
      "transform",
      `translate(${round2(motion.tx * 28)} ${round2(-motion.ty * 28)}) translate(${L} ${L}) scale(${round2(
        motion.sx,
      )} ${round2(motion.sy)}) translate(${-L} ${-L})`,
    );

    const shadowScale = clamp(1 + motion.ty * 0.8 - motion.sx * 0.12, 0.6, 1.3);
    const shadowShift = clamp(-projection.vzx * 0.18, -0.16, 0.16);
    this.shadow.style.transform = `translateX(calc(-50% + ${
      round2(shadowShift * 100)
    }%)) scaleX(${round2(shadowScale)})`;
    this.shadow.style.opacity = String(
      round2(clamp(0.72 - motion.ty * 0.9, 0.18, 0.82)),
    );

    if (this.progressArc) {
      const progress = (Math.sin(this.t * 1.1) * 0.5 + 0.5) * 0.78 + 0.05;
      this.progressArc.setAttribute(
        "stroke-dashoffset",
        String(round2(867.08 * (1 - progress))),
      );
    }
  }

  resize() {
    if (!this.host) return;
    this.host.style.width = this.sizeValue;
    this.host.style.height = this.sizeValue;
  }

  attach() {
    if (!this.host) return;
    this.host.addEventListener("pointermove", this.boundPointerMove, {
      passive: true,
    });
    this.host.addEventListener("pointerdown", this.boundPointerDown);
    this.host.addEventListener("pointerup", this.boundPointerUp);
    this.host.addEventListener("pointercancel", this.boundPointerUp);
    this.host.addEventListener("pointerleave", this.boundPointerLeave);
    this.host.addEventListener("keydown", this.boundKeyDown);
    if (this.options.followPointer) {
      window.addEventListener("pointermove", this.boundWindowPointerMove, {
        passive: true,
      });
    }
  }

  detach() {
    if (!this.host) return;
    this.host.removeEventListener("pointermove", this.boundPointerMove);
    this.host.removeEventListener("pointerdown", this.boundPointerDown);
    this.host.removeEventListener("pointerup", this.boundPointerUp);
    this.host.removeEventListener("pointercancel", this.boundPointerUp);
    this.host.removeEventListener("pointerleave", this.boundPointerLeave);
    this.host.removeEventListener("keydown", this.boundKeyDown);
    window.removeEventListener("pointermove", this.boundWindowPointerMove);
  }

  setGazeFromEvent(event) {
    const rect = this.host.getBoundingClientRect();
    this.targetGaze = {
      x: clamp(((event.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1),
      y: clamp(-((event.clientY - rect.top) / rect.height - 0.5) * 2, -1, 1),
    };
  }

  onPointerMove(event) {
    if (!this.host) return;
    this.hovering = true;
    if (this.dragging && this.lastPointer) {
      const dx = event.clientX - this.lastPointer.x;
      const dy = event.clientY - this.lastPointer.y;
      if (Math.hypot(dx, dy) > 1) this.pointerDown.moved = true;
      if (this.options.dragMode === "rotate") {
        this.manualYaw += dx * 0.011;
        this.manualPitch += dy * 0.009;
        this.manualVelocityYaw = dx * 0.28;
        this.manualVelocityPitch = dy * 0.22;
      } else {
        this.dragOffset.x = clamp(
          event.clientX - this.pointerDown.startX,
          -180,
          180,
        );
        this.dragOffset.y = clamp(
          event.clientY - this.pointerDown.startY,
          -180,
          180,
        );
      }
      this.lastPointer = { x: event.clientX, y: event.clientY };
    } else {
      this.setGazeFromEvent(event);
    }
  }

  onWindowPointerMove(event) {
    if (!this.options.followPointer || this.dragging) return;
    const rect = this.host.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const radius = Math.max(rect.width, rect.height) * 1.25;
    this.targetGaze = {
      x: clamp((event.clientX - centerX) / radius, -1, 1),
      y: clamp(-(event.clientY - centerY) / radius, -1, 1),
    };
  }

  onPointerDown(event) {
    if (!this.options.interactive) return;
    this.host.focus({ preventScroll: true });
    this.pointerDown = {
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    this.lastPointer = { x: event.clientX, y: event.clientY };
    if (this.options.draggable) {
      this.dragging = true;
      this.host.classList.add("aa-is-dragging");
      this.host.setPointerCapture?.(event.pointerId);
    }
  }

  onPointerUp(event) {
    if (!this.pointerDown) return;
    const moved = this.pointerDown.moved;
    this.dragging = false;
    this.host.classList.remove("aa-is-dragging");
    if (this.host.hasPointerCapture?.(event.pointerId)) {
      this.host.releasePointerCapture(event.pointerId);
    }
    if (!moved) this.poke(this.options.clickAction);
    this.pointerDown = null;
    this.lastPointer = null;
  }

  onPointerLeave() {
    this.hovering = false;
    if (!this.options.followPointer) {
      this.targetGaze = { x: 0, y: 0 };
    }
  }

  onKeyDown(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.poke(this.options.clickAction);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (event.shiftKey) {
        this.manualYaw -= degToRad(15);
      } else {
        this.targetGaze = { x: -0.9, y: 0 };
      }
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (event.shiftKey) {
        this.manualYaw += degToRad(15);
      } else {
        this.targetGaze = { x: 0.9, y: 0 };
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (event.shiftKey) {
        this.manualPitch -= degToRad(12);
      } else {
        this.targetGaze = { x: 0, y: 0.9 };
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (event.shiftKey) {
        this.manualPitch += degToRad(12);
      } else {
        this.targetGaze = { x: 0, y: -0.9 };
      }
    }
  }

  getStaticSvg(size = 512) {
    const host = document.createElement("div");
    const engine = new AgentAvatar25DEngine(host, {
      ...this.options,
      paused: true,
      effects: false,
      ring: false,
      shadow: false,
    });
    engine.stop();
    engine.detach();
    engine.setView({ yaw: -18, pitch: 10, roll: -2 });
    const svg = engine.svg.cloneNode(true);
    engine.destroy();
    svg.querySelector(".aa25-fx")?.remove();
    if (!this.options.facetLines) {
      svg.querySelectorAll(".aa25-facet").forEach((node) => node.remove());
    }
    const ink = this.inkValue;
    svg.querySelectorAll('[fill="var(--aa-ink)"]').forEach((node) => {
      node.setAttribute("fill", ink);
    });
    svg.querySelectorAll('[stroke="var(--aa-ink)"]').forEach((node) => {
      node.setAttribute("stroke", ink);
    });
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", this.options.ariaLabel ?? "智能体头像");
    svg.removeAttribute("aria-hidden");
    return svg.outerHTML;
  }

  async getPngDataUrl(size = 512) {
    const svg = this.getStaticSvg(size);
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(image, 0, 0, size, size);
    return canvas.toDataURL("image/png");
  }
}

export {
  AgentAvatar25DEngine,
  DEFAULTS as DEFAULTS_25D,
  projectionFor,
  rotatePoint,
  shadeColor,
};
