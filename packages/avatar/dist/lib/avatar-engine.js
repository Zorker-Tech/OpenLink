/**
 * Botform Avatar Engine
 *
 * A dependency-free procedural avatar renderer with deterministic character
 * defaults, eye expressions, the full state vocabulary, gaze behavior and poke
 * actions. The same data drives the flat SVG, 2.5D and 3D renderers.
 */

const L = 114.2705;
const TAU = Math.PI * 2;
const VIEWBOX = "-20 -20 268.541 268.541";
const VB_SIZE = 268.541;
const EPS = 1e-7;

const round2 = (value) => Math.round(value * 100) / 100;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const smoothstep = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/* -------------------------------------------------------------------------- */
/* Avatar vocabulary                                                          */
/* -------------------------------------------------------------------------- */

const COLORS = [
  { id: "black", label: "墨黑", light: "#000000", dark: "#FFFFFF", swatch: "#111111" },
  { id: "brown", label: "棕色", light: "#A27952", dark: "#855C36", swatch: "#A27952" },
  { id: "red", label: "红色", light: "#FF3E51", dark: "#E02135", swatch: "#FF3E51" },
  { id: "orange", label: "橙色", light: "#FF781C", dark: "#FF6700", swatch: "#FF781C" },
  { id: "yellow", label: "黄色", light: "#FFAF38", dark: "#FF9800", swatch: "#FFAF38" },
  { id: "green", label: "绿色", light: "#00C972", dark: "#009957", swatch: "#00C972" },
  { id: "cyan", label: "青色", light: "#1CC3B0", dark: "#00A592", swatch: "#1CC3B0" },
  { id: "blue", label: "蓝色", light: "#2A92FE", dark: "#0E74E0", swatch: "#2A92FE" },
  { id: "violet", label: "紫色", light: "#A97EFE", dark: "#804EE0", swatch: "#A97EFE" },
  { id: "magenta", label: "品红", light: "#FF5EB1", dark: "#E02A88", swatch: "#FF5EB1" },
  { id: "gray", label: "灰色", light: "#959595", dark: "#777777", swatch: "#959595" },
];

const SHAPES = [
  { id: "blob", label: "球体", en: "Blob", family: "Round" },
  { id: "pebble", label: "卵石", en: "Pebble", family: "Round" },
  { id: "bean", label: "豆形", en: "Bean", family: "Round" },
  { id: "egg", label: "蛋形", en: "Egg", family: "Round" },
  { id: "squircle", label: "方圆形", en: "Squircle", family: "Round" },
  { id: "tablet", label: "平板", en: "Tablet", family: "Soft" },
  { id: "capsule", label: "胶囊", en: "Capsule", family: "Soft" },
  { id: "cylinder", label: "圆柱", en: "Cylinder", family: "Soft" },
  { id: "hex", label: "六边形", en: "Hex", family: "Geometric" },
  { id: "gem", label: "宝石", en: "Gem", family: "Geometric" },
  { id: "crystal", label: "水晶", en: "Crystal", family: "Geometric" },
  { id: "wedge", label: "楔形", en: "Wedge", family: "Geometric" },
  { id: "shield", label: "盾形", en: "Shield", family: "Geometric" },
  { id: "dome", label: "穹顶", en: "Dome", family: "Architectural" },
  { id: "arch", label: "拱形", en: "Arch", family: "Architectural" },
  { id: "cloud", label: "云形", en: "Cloud", family: "Organic" },
  { id: "teardrop", label: "水滴", en: "Teardrop", family: "Organic" },
  { id: "leaf", label: "叶片", en: "Leaf", family: "Organic" },
  { id: "square", label: "方形", en: "Square", family: "Geometric" },
  { id: "sparkle", label: "星芒", en: "Sparkle", family: "Symbol" },
  { id: "clover", label: "四叶", en: "Clover", family: "Symbol" },
  { id: "flower", label: "花朵", en: "Flower", family: "Symbol" },
  { id: "heart", label: "爱心", en: "Heart", family: "Symbol" },
  { id: "house", label: "房子", en: "House", family: "Symbol" },
  { id: "star", label: "星形", en: "Star", family: "Symbol" },
  { id: "pumpkin", label: "南瓜", en: "Pumpkin", family: "Seasonal" },
];

const STATE_GROUPS = [
  {
    label: "生命周期",
    en: "Lifecycle",
    states: [
      ["idle", "空闲"],
      ["listening", "聆听"],
      ["thinking", "思考"],
      ["streaming", "流式输出"],
      ["searching", "搜索"],
      ["reading", "阅读"],
      ["working", "工作"],
      ["coding", "编码"],
      ["running", "运行"],
      ["computing", "计算"],
      ["controlling", "控制"],
      ["waiting", "等待"],
      ["blocked", "受阻"],
      ["finished", "完成"],
      ["failed", "失败"],
      ["sleeping", "睡眠"],
      ["waking", "唤醒"],
    ],
  },
  {
    label: "反应",
    en: "Reactions",
    states: [
      ["happy", "开心"],
      ["excited", "兴奋"],
      ["laughing", "大笑"],
      ["proud", "自豪"],
      ["curious", "好奇"],
      ["playful", "顽皮"],
      ["shy", "害羞"],
      ["surprised", "惊讶"],
      ["suspicious", "怀疑"],
      ["angry", "生气"],
      ["confused", "困惑"],
      ["sad", "难过"],
      ["drowsy", "困倦"],
      ["bored", "无聊"],
      ["scared", "害怕"],
      ["celebrate", "庆祝"],
      ["approving", "赞许"],
    ],
  },
  {
    label: "形变",
    en: "Morphs",
    states: [
      ["orbit", "环绕"],
      ["radar", "雷达"],
      ["progress", "进度"],
      ["spawning", "生成"],
      ["loading", "加载"],
      ["dictating", "听写"],
      ["sending", "发送"],
      ["receiving", "接收"],
      ["uploading", "上传"],
      ["writing", "书写"],
      ["alerting", "警报"],
      ["bouncing", "弹跳"],
      ["powering-down", "关机"],
    ],
  },
  {
    label: "产品",
    en: "Product",
    states: [
      ["humming", "嗡鸣"],
      ["notifying", "通知"],
      ["dragging", "拖拽"],
    ],
  },
  {
    label: "品牌",
    en: "Brand",
    states: [
      ["logo", "标志"],
      ["showcase", "展示"],
      ["turntable", "转台"],
    ],
  },
];

const STATES = STATE_GROUPS.flatMap((group) =>
  group.states.map(([id, label]) => ({
    id,
    label,
    group: group.label,
    groupEn: group.en,
  })),
);

const EXPRESSIONS = {
  neutral: { kind: "capsule", width: 0.26, height: 0.57, tilt: 0 },
  happy: {
    kind: "arc",
    width: 0.13,
    points: [
      [0.16, -0.04],
      [0, 0.12],
      [-0.16, -0.04],
    ],
  },
  surprised: { kind: "capsule", width: 0.42, height: 0.86, tilt: 0, off: [0, 0.03] },
  inspecting: [
    { kind: "capsule", width: 0.54, height: 0.54, tilt: 0, off: [0, 0.04] },
    { kind: "capsule", width: 0.36, height: 0.36, tilt: 0, off: [0, 0.04] },
  ],
  sad: { kind: "capsule", width: 0.26, height: 0.5, tilt: -28, off: [0, -0.05] },
  sleepy: {
    kind: "arc",
    width: 0.13,
    points: [
      [-0.11, 0.025],
      [0, -0.05],
      [0.11, 0.025],
    ],
  },
  squinted: { kind: "capsule", width: 0.26, height: 0.5, tilt: 90, off: [0, 0.01] },
  calm: { kind: "oval", rx: 0.296, ry: 0.247, off: [0.05, 0] },
  confused: {
    kind: "arc",
    width: 0.13,
    points: [
      [0.01, 0.16],
      [-0.17, 0],
      [0.01, -0.16],
    ],
  },
};

const STATE_EXPRESSION = {
  idle: "neutral",
  listening: "calm",
  thinking: "neutral",
  streaming: "neutral",
  searching: "neutral",
  reading: "neutral",
  working: "neutral",
  coding: "neutral",
  running: "neutral",
  computing: "neutral",
  controlling: "neutral",
  waiting: "calm",
  blocked: "sad",
  finished: "happy",
  failed: "sad",
  sleeping: "sleepy",
  waking: "surprised",
  happy: "happy",
  excited: "happy",
  laughing: "happy",
  proud: "happy",
  curious: "inspecting",
  playful: "happy",
  shy: "calm",
  surprised: "surprised",
  suspicious: "squinted",
  angry: "squinted",
  confused: "confused",
  sad: "sad",
  drowsy: "sleepy",
  bored: "sleepy",
  scared: "surprised",
  celebrate: "happy",
  approving: "happy",
  orbit: "neutral",
  radar: "neutral",
  progress: "neutral",
  spawning: "neutral",
  loading: "neutral",
  dictating: "neutral",
  sending: "neutral",
  receiving: "neutral",
  uploading: "neutral",
  writing: "neutral",
  alerting: "surprised",
  bouncing: "happy",
  "powering-down": "sleepy",
  humming: "calm",
  notifying: "surprised",
  dragging: "surprised",
  logo: "neutral",
  showcase: "happy",
  turntable: "neutral",
};

const STATE_EFFECTS = {
  idle: [],
  listening: ["ring"],
  thinking: ["dots"],
  streaming: ["stream"],
  searching: ["radar"],
  reading: ["dots"],
  working: ["dots"],
  coding: ["dots"],
  running: ["dots"],
  computing: ["dots"],
  controlling: ["dots"],
  waiting: ["orbit"],
  blocked: ["zzz"],
  finished: ["sparkle", "confetti"],
  failed: ["bang"],
  sleeping: ["zzz"],
  waking: ["sparkle"],
  happy: ["sparkle"],
  excited: ["confetti"],
  laughing: ["sparkle"],
  proud: ["sparkle"],
  curious: ["dots"],
  playful: ["sparkle"],
  shy: ["ring"],
  surprised: ["bang"],
  suspicious: ["dots"],
  angry: ["bang"],
  confused: ["dots"],
  sad: ["zzz"],
  drowsy: ["zzz"],
  bored: ["zzz"],
  scared: ["bang"],
  celebrate: ["confetti", "sparkle"],
  approving: ["sparkle"],
  orbit: ["orbit"],
  radar: ["radar"],
  progress: ["progress"],
  spawning: ["spawn"],
  loading: ["progress"],
  dictating: ["wave"],
  sending: ["send"],
  receiving: ["receive"],
  uploading: ["dock"],
  writing: ["pencil"],
  alerting: ["bang"],
  bouncing: ["ball"],
  "powering-down": ["standby"],
  humming: ["hum"],
  notifying: ["notify"],
  dragging: ["drag"],
  logo: ["ring", "sparkle"],
  showcase: ["orbit", "sparkle"],
  turntable: ["ring"],
};

const STATE_MOTION = {
  idle: { bob: 1, sway: 0.5, tilt: 0.4 },
  listening: { bob: 0.8, sway: 0.4, tilt: 0.3, breathe: 1.2 },
  thinking: { bob: 0.7, sway: 1.2, tilt: 1.2, tiltX: -2 },
  streaming: { bob: 1.3, sway: 0.4, tilt: 0.6, pulse: 0.4 },
  searching: { bob: 0.8, sway: 0.8, tilt: 0.8, turn: 0.25 },
  reading: { bob: 0.9, sway: 0.4, tilt: 0.4, tiltX: 1.5 },
  working: { bob: 1.2, sway: 0.4, tilt: 0.5, jitter: 0.25 },
  coding: { bob: 1.1, sway: 0.3, tilt: 0.4, jitter: 0.35 },
  running: { bob: 1.6, sway: 0.6, tilt: 0.8, jitter: 0.45 },
  computing: { bob: 1.4, sway: 0.5, tilt: 0.6, jitter: 0.3 },
  controlling: { bob: 1.1, sway: 0.7, tilt: 0.7, turn: 0.2 },
  waiting: { bob: 1.8, sway: 0.8, tilt: 0.5 },
  blocked: { bob: 0.4, sway: 0.3, tilt: 0.2, shake: 0.7 },
  finished: { bob: 2.2, sway: 0.5, tilt: 0.8, bounce: 1 },
  failed: { bob: 0.4, sway: 0.4, tilt: 0.2, shake: 1.2 },
  sleeping: { bob: 0.8, sway: 0.2, tilt: 0.1, breathe: 1.8 },
  waking: { bob: 1.6, sway: 0.4, tilt: 0.6, bounce: 0.6 },
  happy: { bob: 2.4, sway: 0.6, tilt: 0.8, bounce: 0.7 },
  excited: { bob: 3.2, sway: 1.2, tilt: 1.4, bounce: 1.3 },
  laughing: { bob: 2.8, sway: 1.4, tilt: 1.2, shake: 0.5 },
  proud: { bob: 1.2, sway: 0.4, tilt: 0.3, tiltX: -2 },
  curious: { bob: 1.1, sway: 0.8, tilt: 1.4, tiltX: 1.5 },
  playful: { bob: 2.4, sway: 1.4, tilt: 1.2, bounce: 0.8 },
  shy: { bob: 0.7, sway: 0.4, tilt: 0.3, tiltX: 2 },
  surprised: { bob: 2.6, sway: 0.4, tilt: 0.7, bounce: 0.9 },
  suspicious: { bob: 0.8, sway: 0.5, tilt: 0.8, tiltX: 1 },
  angry: { bob: 1.2, sway: 0.4, tilt: 0.3, shake: 1 },
  confused: { bob: 0.8, sway: 1.2, tilt: 1.2, tiltX: 2 },
  sad: { bob: 0.4, sway: 0.3, tilt: 0.2, tiltX: 2 },
  drowsy: { bob: 0.6, sway: 0.3, tilt: 0.2, breathe: 1.2 },
  bored: { bob: 0.5, sway: 0.3, tilt: 0.2, tiltX: 1 },
  scared: { bob: 0.7, sway: 0.5, tilt: 0.3, shake: 0.9 },
  celebrate: { bob: 2.8, sway: 0.8, tilt: 1.2, bounce: 1.2, spin: 0.55 },
  approving: { bob: 1.6, sway: 0.4, tilt: 0.5, bounce: 0.5 },
  orbit: { bob: 1.2, sway: 0.8, tilt: 0.7 },
  radar: { bob: 0.8, sway: 0.5, tilt: 0.5, turn: 0.4 },
  progress: { bob: 1, sway: 0.3, tilt: 0.4, pulse: 0.5 },
  spawning: { bob: 1.6, sway: 0.6, tilt: 0.7, pulse: 0.6 },
  loading: { bob: 1, sway: 0.3, tilt: 0.4, pulse: 0.5 },
  dictating: { bob: 0.8, sway: 0.3, tilt: 0.3, pulse: 0.8 },
  sending: { bob: 1.4, sway: 0.4, tilt: 0.5, pulse: 0.6 },
  receiving: { bob: 1.4, sway: 0.4, tilt: 0.5, pulse: 0.6 },
  uploading: { bob: 1.2, sway: 0.4, tilt: 0.5, pulse: 0.5 },
  writing: { bob: 0.9, sway: 0.8, tilt: 0.8, tiltX: 1.5 },
  alerting: { bob: 1.6, sway: 0.4, tilt: 0.5, shake: 0.6 },
  bouncing: { bob: 0.4, sway: 0.3, tilt: 0.3, bounce: 1.8 },
  "powering-down": { bob: 0.4, sway: 0.2, tilt: 0.1, powerDown: 1 },
  humming: { bob: 0.8, sway: 0.3, tilt: 0.3, jitter: 0.3 },
  notifying: { bob: 2, sway: 0.4, tilt: 0.6, bounce: 0.8 },
  dragging: { bob: 0.8, sway: 0.4, tilt: 0.6, dragLean: 1 },
  logo: { bob: 0.8, sway: 0.3, tilt: 0.3, turn: 0.3 },
  showcase: { bob: 1.4, sway: 0.8, tilt: 0.8, turn: 0.5 },
  turntable: { bob: 0.6, sway: 0.3, tilt: 0.3, spin: 1 },
};

const AUTO_NEXT = {
  finished: { next: "idle", holdSeconds: 2.6 },
  failed: { next: "idle", holdSeconds: 2.6 },
  waking: { next: "idle", holdSeconds: 1.6 },
  approving: { next: "idle", holdSeconds: 2.2 },
  blocked: { next: "drowsy", holdSeconds: 8 },
};

const DEFAULT_SHAPES_8 = [
  "blob",
  "pebble",
  "squircle",
  "tablet",
  "wedge",
  "hex",
  "cloud",
  "teardrop",
];

const DEFAULT_SHAPES_13 = [
  "blob",
  "cloud",
  "square",
  "sparkle",
  "clover",
  "heart",
  "flower",
  "teardrop",
  "tablet",
  "wedge",
  "house",
  "star",
  "hex",
];

/* -------------------------------------------------------------------------- */
/* Deterministic character defaults (FNV + mulberry32)                        */
/* -------------------------------------------------------------------------- */

function fnv1a(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 1831565813) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashColor(seed) {
  const state = (fnv1a(String(seed)) ^ Math.imul(1, 2654435769)) >>> 0;
  const random = mulberry32(state);
  const palette = COLORS.filter((color) => color.id !== "black");
  return palette[Math.floor(random() * palette.length)]?.id ?? "blue";
}

function hashShape(seed, compact = false) {
  let value = fnv1a(String(seed)) | 0;
  value = Math.imul(value ^ (value >>> 16), 73244475);
  value = Math.imul(value ^ (value >>> 13), 3266489909);
  value = (value ^ (value >>> 16)) >>> 0;
  const list = compact ? DEFAULT_SHAPES_13 : DEFAULT_SHAPES_8;
  return list[value % list.length] ?? "blob";
}

/* -------------------------------------------------------------------------- */
/* Silhouette builders                                                        */
/* -------------------------------------------------------------------------- */

class PathBuilder {
  constructor() {
    this.d = "";
  }

  move(x, y) {
    this.d += `M${round2(x)} ${round2(y)}`;
    return this;
  }

  line(x, y) {
    this.d += `L${round2(x)} ${round2(y)}`;
    return this;
  }

  curve(x1, y1, x2, y2, x, y) {
    this.d += `C${round2(x1)} ${round2(y1)} ${round2(x2)} ${round2(y2)} ${round2(x)} ${round2(y)}`;
    return this;
  }

  corner(prev, corner, next, radius) {
    const normalize = (a, b) => {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const length = Math.hypot(dx, dy) || 1;
      return [dx / length, dy / length];
    };
    const before = normalize(prev, corner);
    const after = normalize(next, corner);
    const start = [corner[0] + before[0] * radius, corner[1] + before[1] * radius];
    const end = [corner[0] + after[0] * radius, corner[1] + after[1] * radius];
    if (this.d) this.line(start[0], start[1]);
    else this.move(start[0], start[1]);
    this.d += `Q${round2(corner[0])} ${round2(corner[1])} ${round2(end[0])} ${round2(end[1])}`;
    return this;
  }

  arc(cx, cy, rx, ry, startAngle, endAngle) {
    const steps = Math.max(1, Math.ceil(Math.abs(endAngle - startAngle) / (Math.PI / 2)));
    const step = (endAngle - startAngle) / steps;
    const k = (4 / 3) * Math.tan(step / 4);
    let angle = startAngle;
    for (let index = 0; index < steps; index += 1) {
      const nextAngle = angle + step;
      const start = [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
      const end = [cx + rx * Math.cos(nextAngle), cy + ry * Math.sin(nextAngle)];
      this.curve(
        start[0] - k * rx * Math.sin(angle),
        start[1] + k * ry * Math.cos(angle),
        end[0] + k * rx * Math.sin(nextAngle),
        end[1] - k * ry * Math.cos(nextAngle),
        end[0],
        end[1],
      );
      angle = nextAngle;
    }
    return this;
  }

  close() {
    return `${this.d}Z`;
  }
}

function smoothClosed(points) {
  if (points.length === 0) return "";
  const count = points.length;
  let path = `M${round2(points[0][0])} ${round2(points[0][1])}`;
  for (let index = 0; index < count; index += 1) {
    const previous = points[(index - 1 + count) % count];
    const current = points[index];
    const next = points[(index + 1) % count];
    const after = points[(index + 2) % count];
    path += `C${round2(current[0] + (next[0] - previous[0]) / 6)} ${round2(
      current[1] + (next[1] - previous[1]) / 6,
    )} ${round2(next[0] - (after[0] - current[0]) / 6)} ${round2(
      next[1] - (after[1] - current[1]) / 6,
    )} ${round2(next[0])} ${round2(next[1])}`;
  }
  return `${path}Z`;
}

function sampleClosed(fn, count = 160) {
  const points = [];
  for (let index = 0; index < count; index += 1) {
    points.push(fn((index / count) * TAU));
  }
  return smoothClosed(points);
}

function roundedPath(points, radius) {
  const builder = new PathBuilder();
  const count = points.length;
  for (let index = 0; index < count; index += 1) {
    const amount = typeof radius === "number" ? radius : radius[index % radius.length];
    builder.corner(points[(index - 1 + count) % count], points[index], points[(index + 1) % count], amount);
  }
  return builder.close();
}

function polygonPath(radius, sides, cornerRadius, rotation = 0) {
  const points = Array.from({ length: sides }, (_, index) => {
    const angle = rotation + (index / sides) * TAU;
    return [L + Math.cos(angle) * radius, L + Math.sin(angle) * radius];
  });
  return roundedPath(points, cornerRadius);
}

function unionCircles(circles, count = 160) {
  return sampleClosed((angle) => {
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    let reach = 0;
    for (const [cx, cy, radius] of circles) {
      const dx = cx - L;
      const dy = cy - L;
      const projection = nx * dx + ny * dy;
      const discriminant = projection * projection - (dx * dx + dy * dy) + radius * radius;
      if (discriminant <= 0) continue;
      const candidate = projection + Math.sqrt(discriminant);
      if (candidate > reach) reach = candidate;
    }
    return [L + nx * reach, L + ny * reach];
  }, count);
}

function superellipsePath(rx, ry, power) {
  return sampleClosed((angle) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
      L + Math.sign(cos) * Math.abs(cos) ** (2 / power) * rx,
      L + Math.sign(sin) * Math.abs(sin) ** (2 / power) * ry,
    ];
  });
}

function tabletPath(width, radius) {
  return new PathBuilder()
    .move(L - width + radius, L - radius)
    .line(L + width - radius, L - radius)
    .arc(L + width - radius, L, radius, radius, -Math.PI / 2, Math.PI / 2)
    .line(L - width + radius, L + radius)
    .arc(L - width + radius, L, radius, radius, Math.PI / 2, (Math.PI * 3) / 2)
    .close();
}

function capsulePath(width, height) {
  return new PathBuilder()
    .move(L - width, L + height - width)
    .line(L - width, L - height + width)
    .arc(L, L - height + width, width, width, Math.PI, TAU)
    .line(L + width, L + height - width)
    .arc(L, L + height - width, width, width, 0, Math.PI)
    .close();
}

function cylinderPath(width, height, radius) {
  return new PathBuilder()
    .move(L - width, L - height + radius)
    .arc(L, L - height + radius, width, radius, Math.PI, TAU)
    .line(L + width, L + height - radius)
    .arc(L, L + height - radius, width, radius, 0, Math.PI)
    .close();
}

function domePath(width, height, radius) {
  const bottom = L + height;
  return new PathBuilder()
    .move(L - width, bottom - radius)
    .arc(L, bottom - radius, width, 2 * height - radius, Math.PI, TAU)
    .line(L + width, bottom - radius)
    .curve(L + width, bottom, L + width, bottom, L + width - radius, bottom)
    .line(L - width + radius, bottom)
    .curve(L - width, bottom, L - width, bottom, L - width, bottom - radius)
    .close();
}

function archPath(width, height, radius) {
  const bottom = L + height;
  const shoulder = L - height + width;
  return new PathBuilder()
    .move(L - width, shoulder)
    .arc(L, shoulder, width, width, Math.PI, TAU)
    .line(L + width, bottom - radius)
    .curve(L + width, bottom, L + width, bottom, L + width - radius, bottom)
    .line(L - width + radius, bottom)
    .curve(L - width, bottom, L - width, bottom, L - width, bottom - radius)
    .close();
}

function shieldPath(width, height, shoulder) {
  const top = L - height;
  const bottom = L + height;
  return new PathBuilder()
    .move(L - width, top + shoulder)
    .curve(L - width, top - 2, L - width * 0.5, top - 10, L, top - 10)
    .curve(L + width * 0.5, top - 10, L + width, top - 2, L + width, top + shoulder)
    .curve(L + width, L + height * 0.42, L + width * 0.62, bottom, L, bottom)
    .curve(L - width * 0.62, bottom, L - width, L + height * 0.42, L - width, top + shoulder)
    .close();
}

function eggPath(width, height, bias) {
  return sampleClosed((angle) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const taper = (1 - sin) / 2;
    return [L + cos * width * (1 - bias * taper * taper), L + sin * height];
  });
}

function leafPath(width, height, exponent) {
  return sampleClosed((angle) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
      L + cos * width * Math.max(1 - sin * sin, 0) ** (exponent / 2 - 0.5),
      L + sin * height,
    ];
  });
}

function beanPath(width, height, notch, phase) {
  return sampleClosed((angle) => {
    const lobe = (center) => {
      let delta = Math.abs((((angle - center + Math.PI) % TAU) + TAU) % TAU - Math.PI);
      return Math.exp(-(delta * delta) / 0.4232);
    };
    const scale = 1 - notch * lobe(phase) + notch * 0.34 * lobe(phase + Math.PI);
    return [L + Math.cos(angle) * width * scale, L + Math.sin(angle) * height * scale];
  });
}

function pebblePath(radius, amplitude, frequency) {
  return sampleClosed((angle) => {
    const wobble =
      radius *
      (1 +
        amplitude *
          (Math.sin(angle * 2 + frequency) * 0.6 + Math.sin(angle * 3 - frequency) * 0.4));
    return [L + Math.cos(angle) * wobble, L + Math.sin(angle) * wobble * 0.98];
  });
}

function cloverPath(width, radius) {
  return unionCircles([
    [L - width, L - width, radius],
    [L + width, L - width, radius],
    [L + width, L + width, radius],
    [L - width, L + width, radius],
  ]);
}

function housePath(width, height, roof, radius) {
  return roundedPath(
    [
      [L - width, L + height],
      [L + width, L + height],
      [L + width, L - height + roof],
      [L, L - height],
      [L - width, L - height + roof],
    ],
    radius,
  );
}

function teardropPath(width, top, bottom, radius) {
  const ratio = clamp(width / (bottom - top), -1, 1);
  const spread = Math.sqrt(1 - ratio * ratio);
  const right = [L + width * spread, bottom - width * ratio];
  const left = [L - width * spread, bottom - width * ratio];
  const angle = Math.atan2(right[1] - bottom, right[0] - L);
  return new PathBuilder()
    .corner(right, [L, top], left, radius)
    .line(left[0], left[1])
    .arc(L, bottom, width, width, Math.PI - angle, angle)
    .close();
}

function flowerPath() {
  const petalDistance = 0.58;
  const balls = [{ x: 0, y: 0, r: 0.36 }];
  for (let index = 0; index < 6; index += 1) {
    const angle = -Math.PI / 2 + (index * TAU) / 6;
    balls.push({
      x: petalDistance * Math.cos(angle),
      y: petalDistance * Math.sin(angle),
      r: 0.33,
    });
  }
  const points = [];
  for (let index = 0; index < 240; index += 1) {
    const angle = (index / 240) * TAU;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let low = 0;
    let high = 0.91;
    for (let step = 0; step < 22; step += 1) {
      const mid = (low + high) / 2;
      const x = mid * cos;
      const y = mid * sin;
      const inside = balls.some(
        (ball) => (x - ball.x) ** 2 + (y - ball.y) ** 2 <= ball.r ** 2,
      );
      if (inside) low = mid;
      else high = mid;
    }
    points.push([L + low * cos * L, L + low * sin * L]);
  }
  return smoothClosed(points);
}

function crystalPath() {
  const points = [
    [L, L - 108],
    [L + 28, L - 92],
    [L + 56, L - 45],
    [L + 62, L + 28],
    [L + 36, L + 88],
    [L, L + 108],
    [L - 36, L + 88],
    [L - 62, L + 28],
    [L - 56, L - 45],
    [L - 28, L - 92],
  ];
  return roundedPath(points, 7);
}

function pumpkinPath() {
  return sampleClosed((angle) => {
    const rib = 1 + 0.045 * Math.cos(angle * 8);
    return [L + Math.cos(angle) * 103 * rib, L + Math.sin(angle) * 96 * rib];
  });
}

const HEART_PATH =
  "M79.4511 11.5693C94.8767 -3.85636 119.887 -3.85622 135.312 11.5693C150.738 26.995 150.738 52.0049 135.312 67.4306L129.302 73.4404L129.303 73.4414L83.7724 118.972C81.8111 120.933 79.4309 122.22 76.9199 122.833C76.463 122.944 76.0018 123.034 75.538 123.101C74.1477 123.301 72.734 123.301 71.3437 123.101C70.8802 123.034 70.4194 122.944 69.9628 122.833C69.8486 122.805 69.7347 122.776 69.621 122.745C69.3938 122.684 69.1679 122.616 68.9433 122.544C67.4837 122.073 66.0831 121.367 64.8017 120.426C64.6047 120.281 64.4108 120.13 64.2197 119.975C63.837 119.662 63.466 119.328 63.1093 118.972L11.5693 67.4306C-3.85643 52.0049 -3.85642 26.995 11.5693 11.5693C26.995 -3.85643 52.0049 -3.85643 67.4306 11.5693L73.4404 17.579L79.4511 11.5693Z";

const SPARKLE_PATH =
  "M93.9365 0.100586C98.4439 -0.387322 102.691 0.897134 106.341 4.03418C111.502 8.47087 114.842 16.0545 116.636 25.2725C118.36 34.1341 118.716 44.8177 117.701 56.4346L117.707 56.4375L117.706 56.4443C122.25 58.5638 126.519 60.8171 130.449 63.168C130.485 63.1891 130.52 63.2103 130.556 63.2314C131.25 63.6478 131.934 64.067 132.607 64.4893C132.68 64.5349 132.753 64.5813 132.825 64.627C133.074 64.7838 133.322 64.941 133.567 65.0986C133.692 65.1787 133.816 65.2596 133.94 65.3398C134.138 65.4676 134.335 65.5954 134.53 65.7236C134.653 65.8039 134.775 65.8844 134.896 65.9648C135.112 66.1073 135.325 66.2506 135.538 66.3936C135.625 66.4522 135.713 66.5106 135.8 66.5693C138.866 68.645 141.667 70.7792 144.163 72.9502C149.754 77.8126 153.981 83.0002 156.136 88.2578C156.159 88.3133 156.181 88.3693 156.203 88.4248C156.268 88.5868 156.332 88.749 156.393 88.9111C156.435 89.0226 156.475 89.1346 156.516 89.2461C156.541 89.3175 156.566 89.3895 156.591 89.4609C157.443 91.8917 157.839 94.3199 157.696 96.7109C157.522 99.7997 156.469 102.655 154.613 105.192C154.236 105.709 153.826 106.208 153.388 106.692C153.365 106.717 153.343 106.742 153.32 106.767C153.171 106.93 153.019 107.091 152.863 107.25C152.844 107.27 152.824 107.29 152.804 107.311C152.3 107.822 151.762 108.316 151.191 108.79C151.168 108.81 151.144 108.83 151.12 108.85C150.952 108.988 150.781 109.125 150.607 109.261C150.558 109.299 150.509 109.337 150.46 109.375C150.282 109.512 150.101 109.648 149.917 109.781C149.903 109.792 149.888 109.801 149.874 109.812C149.255 110.26 148.605 110.689 147.926 111.1C147.795 111.179 147.662 111.256 147.528 111.334C147.41 111.403 147.292 111.473 147.173 111.541C146.915 111.687 146.653 111.832 146.388 111.974C146.316 112.012 146.243 112.047 146.171 112.085C145.978 112.186 145.783 112.287 145.586 112.386C145.459 112.449 145.331 112.511 145.203 112.573C145.048 112.649 144.891 112.723 144.733 112.797C144.614 112.853 144.494 112.909 144.373 112.964C144.198 113.044 144.021 113.122 143.843 113.2C143.722 113.253 143.6 113.306 143.478 113.358C143.288 113.439 143.096 113.519 142.903 113.598C142.836 113.625 142.769 113.655 142.701 113.683C142.662 113.698 142.622 113.712 142.583 113.728C142.371 113.812 142.156 113.895 141.94 113.978C141.847 114.013 141.753 114.051 141.658 114.086C140.71 114.441 139.731 114.771 138.725 115.078C138.613 115.112 138.502 115.145 138.39 115.179C138.257 115.218 138.123 115.26 137.989 115.299C137.911 115.322 137.831 115.343 137.752 115.365C137.61 115.406 137.467 115.446 137.324 115.485C137.095 115.549 136.863 115.611 136.63 115.672C136.52 115.701 136.41 115.73 136.3 115.759C136.064 115.819 135.827 115.879 135.588 115.938C135.451 115.971 135.314 116.004 135.177 116.037C134.975 116.085 134.772 116.131 134.568 116.178C134.312 116.236 134.054 116.294 133.795 116.35C133.535 116.406 133.274 116.461 133.011 116.515C132.85 116.547 132.688 116.578 132.525 116.61C132.333 116.648 132.14 116.686 131.946 116.723C131.689 116.771 131.43 116.818 131.17 116.864C131.075 116.881 130.979 116.898 130.884 116.914C130.595 116.964 130.304 117.012 130.012 117.06C129.932 117.073 129.851 117.085 129.771 117.098C129.484 117.143 129.196 117.188 128.906 117.23C128.818 117.243 128.729 117.256 128.641 117.269C127.33 117.457 125.983 117.62 124.601 117.755C124.468 117.768 124.336 117.782 124.203 117.794C123.92 117.82 123.636 117.845 123.351 117.869C123.24 117.878 123.13 117.888 123.02 117.897C122.701 117.923 122.381 117.948 122.059 117.971C121.967 117.977 121.874 117.984 121.782 117.99C121.463 118.012 121.143 118.033 120.82 118.053C120.73 118.058 120.639 118.063 120.549 118.068C119.546 118.126 118.527 118.171 117.492 118.202C117.322 118.207 117.151 118.213 116.979 118.218C116.785 118.223 116.59 118.225 116.395 118.229C116.147 118.235 115.899 118.24 115.65 118.244C115.415 118.248 115.178 118.25 114.94 118.252C114.688 118.254 114.435 118.256 114.181 118.257C114.008 118.257 113.835 118.257 113.662 118.257C113.32 118.256 112.976 118.255 112.631 118.252C112.503 118.251 112.375 118.25 112.247 118.248C111.858 118.243 111.466 118.237 111.073 118.229C110.984 118.227 110.894 118.226 110.804 118.224C107.734 118.154 104.558 117.977 101.289 117.69C96.3593 128.261 90.7082 137.338 84.7832 144.151C78.6204 151.238 71.9357 156.137 65.2471 157.399C60.5179 158.292 56.1975 157.281 52.5381 154.604C48.9431 151.975 46.1246 147.845 44.0479 142.691C40.0321 132.725 38.5457 118.333 40.043 101.281C40.0382 101.279 40.0331 101.277 40.0283 101.274C39.6986 101.121 39.3711 100.965 39.0449 100.811C38.8351 100.711 38.6254 100.612 38.417 100.512C38.0794 100.35 37.7438 100.186 37.4102 100.023C37.2392 99.9399 37.0684 99.8563 36.8984 99.7725C36.5886 99.6196 36.2801 99.4663 35.9736 99.3125C35.7564 99.2034 35.5398 99.0939 35.3242 98.9844C34.9817 98.8104 34.6409 98.636 34.3027 98.4609C34.2424 98.4297 34.1823 98.3975 34.1221 98.3662C19.2858 90.6566 8.70839 81.8767 3.56055 73.3232C3.50461 73.2303 3.44926 73.137 3.39453 73.0439C3.37308 73.0075 3.35134 72.971 3.33008 72.9346C3.19352 72.7003 3.06142 72.4652 2.93262 72.2305C2.19429 70.8865 1.58552 69.5375 1.11816 68.1895C1.10444 68.1499 1.09161 68.1099 1.07813 68.0703C1.04009 67.9586 1.00191 67.847 0.96582 67.7354C0.954674 67.7009 0.943578 67.6663 0.932617 67.6318C0.823298 67.2877 0.723275 66.9435 0.632813 66.5996C-0.103732 63.8123 -0.218301 61.0433 0.402344 58.3643C1.34437 54.2986 3.89972 50.7745 7.875 47.9023C7.90661 47.8794 7.93796 47.8559 7.96973 47.833C8.12646 47.7208 8.2852 47.6092 8.44629 47.499C8.57825 47.4084 8.71216 47.3194 8.84668 47.2305C8.87052 47.2148 8.89404 47.1983 8.91797 47.1826C10.608 46.0723 12.497 45.0908 14.5547 44.2324C14.6355 44.1986 14.7165 44.1643 14.7979 44.1309C14.8508 44.1092 14.9038 44.087 14.957 44.0654L15.25 43.9482C15.3501 43.9084 15.4509 43.8694 15.5518 43.8301C15.6093 43.8078 15.6668 43.7848 15.7246 43.7627C23.7646 40.6682 34.1765 39.3165 45.6846 39.4756C45.8574 39.4779 46.0307 39.4814 46.2041 39.4844C46.4305 39.4884 46.6576 39.4909 46.8848 39.4961C47.3568 39.5065 47.8313 39.5207 48.3076 39.5361C48.4142 39.5397 48.5212 39.5441 48.6279 39.5479C51.1795 39.6366 53.791 39.7967 56.4512 40.0293C63.6811 24.5137 72.1655 12.7934 80.627 6.1709C85.0025 2.74635 89.5085 0.57999 93.9365 0.100586Z";

const STAR_PATH =
  "M58.9438 9.25323C63.2492 -3.08441 80.6974 -3.08441 85.0027 9.25322L91.7612 28.6207C94.0136 35.0751 100.652 38.9078 107.368 37.6311L127.52 33.8004C140.357 31.3602 149.081 46.4708 140.549 56.3681L127.156 71.9049C122.692 77.0827 122.692 84.748 127.156 89.9258L140.549 105.463C149.081 115.36 140.357 130.471 127.52 128.03L107.368 124.2C100.652 122.923 94.0136 126.756 91.7612 133.21L85.0027 152.577C80.6974 164.915 63.2492 164.915 58.9438 152.577L52.1853 133.21C49.933 126.756 43.2946 122.923 36.5788 124.2L16.4268 128.03C3.58942 130.471 -5.1347 115.36 3.39733 105.463L16.7908 89.9258C21.2543 84.748 21.2543 77.0827 16.7908 71.9049L3.39734 56.3681C-5.13469 46.4708 3.58941 31.3602 16.4268 33.8004L36.5787 37.6311C43.2946 38.9078 49.933 35.0751 52.1853 28.6207L58.9438 9.25323Z";

const SHAPE_BUILDERS = {
  blob: () => sampleClosed((angle) => [L + Math.cos(angle) * 108, L + Math.sin(angle) * 108]),
  pebble: () => pebblePath(108, 0.075, 1.1),
  bean: () => beanPath(94, 112, 0.34, Math.PI),
  egg: () => eggPath(98, 113, 0.22),
  squircle: () => superellipsePath(107, 107, 3.2),
  tablet: () => tabletPath(114, 74),
  capsule: () => capsulePath(72, 113),
  cylinder: () => cylinderPath(94, 110, 48),
  hex: () => polygonPath(114, 6, 20, Math.PI / 6),
  gem: () => superellipsePath(112, 113, 1.5),
  crystal: () => crystalPath(),
  wedge: () => polygonPath(130, 3, [60, 80, 80], -Math.PI / 2),
  shield: () => shieldPath(98, 108, 30),
  dome: () => domePath(114, 82, 26),
  arch: () => archPath(76, 113, 42),
  cloud: () =>
    unionCircles([
      [L - 62, L + 26, 56],
      [L + 62, L + 26, 54],
      [L, L + 34, 62],
      [L - 24, L - 30, 62],
      [L + 38, L - 26, 54],
    ]),
  teardrop: () => teardropPath(88, L - 114, L + 26, 48),
  leaf: () => leafPath(88, 113, 1.5),
  square: () => roundedPath(
    [
      [L - 107, L - 107],
      [L + 107, L - 107],
      [L + 107, L + 107],
      [L - 107, L + 107],
    ],
    28,
  ),
  sparkle: () => SPARKLE_PATH,
  clover: () => cloverPath(38, 58),
  flower: () => flowerPath(),
  heart: () => HEART_PATH,
  house: () => housePath(100, 110, 78, 29),
  star: () => STAR_PATH,
  pumpkin: () => pumpkinPath(),
};

function parsePathPoints(path) {
  const tokens = path.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const points = [];
  let index = 0;
  let command = "";
  let startX = 0;
  let startY = 0;
  let x = 0;
  let y = 0;
  const read = () => Number.parseFloat(tokens[index++]);
  const addSegment = (fn, length) => {
    const steps = Math.max(2, Math.ceil(length / 4));
    for (let step = 1; step <= steps; step += 1) {
      points.push(fn(step / steps));
    }
  };
  while (index < tokens.length) {
    if (/[a-z]/i.test(tokens[index])) command = tokens[index++].toUpperCase();
    if (command === "Z") {
      if (Math.hypot(x - startX, y - startY) > 0.01) {
        addSegment((t) => [x + (startX - x) * t, y + (startY - y) * t], Math.hypot(x - startX, y - startY));
      }
      x = startX;
      y = startY;
      continue;
    }
    if (index >= tokens.length) break;
    if (command === "M") {
      x = read();
      y = read();
      startX = x;
      startY = y;
      points.push([x, y]);
      command = "L";
    } else if (command === "L") {
      const nx = read();
      const ny = read();
      addSegment((t) => [x + (nx - x) * t, y + (ny - y) * t], Math.hypot(nx - x, ny - y));
      x = nx;
      y = ny;
    } else if (command === "Q") {
      const cx = read();
      const cy = read();
      const nx = read();
      const ny = read();
      const ox = x;
      const oy = y;
      addSegment((t) => {
        const inv = 1 - t;
        return [
          inv * inv * ox + 2 * inv * t * cx + t * t * nx,
          inv * inv * oy + 2 * inv * t * cy + t * t * ny,
        ];
      }, Math.hypot(cx - x, cy - y) + Math.hypot(nx - cx, ny - cy));
      x = nx;
      y = ny;
    } else {
      const c1x = read();
      const c1y = read();
      const c2x = read();
      const c2y = read();
      const nx = read();
      const ny = read();
      const ox = x;
      const oy = y;
      addSegment((t) => {
        const inv = 1 - t;
        return [
          inv ** 3 * ox + 3 * inv * inv * t * c1x + 3 * inv * t * t * c2x + t ** 3 * nx,
          inv ** 3 * oy + 3 * inv * inv * t * c1y + 3 * inv * t * t * c2y + t ** 3 * ny,
        ];
      }, Math.hypot(c1x - x, c1y - y) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(nx - c2x, ny - c2y));
      x = nx;
      y = ny;
    }
  }
  return points;
}

function transformPath(path, scale, dx, dy) {
  let index = 0;
  return path.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (token) => {
    index ^= 1;
    const value = Number.parseFloat(token) + (index ? dx : dy);
    return String(round2(L + (value - L) * scale));
  });
}

function fitPath(path) {
  const points = parsePathPoints(path);
  if (points.length < 4) return path;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const scale = clamp(228.44 / Math.max(maxX - minX, maxY - minY, 1), 0.7, 1.35);
  const dx = L - (minX + maxX) / 2;
  const dy = L - (minY + maxY) / 2;
  if (Math.abs(scale - 1) < 0.004 && Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) {
    return path;
  }
  return transformPath(path, scale, dx, dy);
}

function scanlineSpan(points) {
  let top = Infinity;
  let bottom = -Infinity;
  for (const [, y] of points) {
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return (targetY) => {
    let min = Infinity;
    let max = -Infinity;
    const count = points.length;
    for (let index = 0; index < count; index += 1) {
      const [x1, y1] = points[index];
      const [x2, y2] = points[(index + 1) % count];
      if (Math.abs(y2 - y1) < EPS) {
        if (Math.abs(y1 - targetY) < 1e-5) {
          min = Math.min(min, x1, x2);
          max = Math.max(max, x1, x2);
        }
        continue;
      }
      if ((y1 <= targetY && y2 >= targetY) || (y2 <= targetY && y1 >= targetY)) {
        const x = x1 + ((x2 - x1) * (targetY - y1)) / (y2 - y1);
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
    return max >= min ? max - min : 0;
  };
}

const shapeCache = new Map();

function getShape(id) {
  const key = SHAPE_BUILDERS[id] ? id : "blob";
  const cached = shapeCache.get(key);
  if (cached) return cached;
  const raw = SHAPE_BUILDERS[key]();
  const path = fitPath(raw);
  const points = parsePathPoints(path);
  let top = Infinity;
  let bottom = -Infinity;
  for (const [, y] of points) {
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  const shape = {
    id: key,
    path,
    points,
    top,
    bottom,
    spanAt: scanlineSpan(points),
  };
  shapeCache.set(key, shape);
  return shape;
}

/* -------------------------------------------------------------------------- */
/* Color + eye helpers                                                        */
/* -------------------------------------------------------------------------- */

function sanitizeColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return trimmed;
  if (/^rgba?\([^)]*\)$/i.test(trimmed)) return trimmed;
  if (/^hsla?\([^)]*\)$/i.test(trimmed)) return trimmed;
  if (/^[a-z]{3,20}$/i.test(trimmed)) return trimmed;
  return fallback;
}

function hexToRgb(color) {
  if (!color.startsWith("#")) return null;
  let hex = color.slice(1);
  if (hex.length === 3) hex = hex.split("").map((char) => char + char).join("");
  if (hex.length !== 6) return null;
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

function luminance(color) {
  const rgb = hexToRgb(color);
  if (!rgb) return 0.5;
  const linear = rgb.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function resolveTheme(theme) {
  if (theme === "light" || theme === "dark") return theme;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

function resolveColor(color, theme) {
  const palette = COLORS.find((item) => item.id === color);
  if (palette) return theme === "light" ? palette.light : palette.dark;
  return sanitizeColor(color, theme === "light" ? "#000000" : "#FFFFFF");
}

function resolveInk(color) {
  return luminance(color) > 0.48 ? "#111111" : "#FFFFFF";
}

function eyeWidth(expression) {
  if (Array.isArray(expression)) return Math.max(...expression.map(eyeWidth));
  if (expression.kind === "oval") return expression.rx * 2;
  return expression.width;
}

function getExpression(name) {
  return EXPRESSIONS[name] ?? EXPRESSIONS.neutral;
}

function eyeMarkup(expressionName, shape, options) {
  const expression = getExpression(expressionName);
  const eyeY = clamp(options.eyeY ?? 0.02, -0.18, 0.22);
  const centerY = L - eyeY * L;
  const span = shape.spanAt(centerY) || 120;
  const half = span / 2;
  const spread = clamp(half * 0.48, L * 0.16, L * 0.38);
  const maxWidth = eyeWidth(expression) * L;
  const fit = clamp((spread * 1.75) / Math.max(maxWidth, 1), 0.32, 1);
  const eyes = Array.isArray(expression) ? expression : [expression, expression];
  const markups = [];
  for (let index = 0; index < 2; index += 1) {
    const eye = eyes[index] ?? eyes[0];
    const direction = index === 0 ? -1 : 1;
    const offset = eye.off ?? [0, 0];
    const cx = L + direction * spread + offset[0] * L;
    const cy = centerY - offset[1] * L;
    const tilt = eye.tilt ?? 0;
    let inner = "";
    if (eye.kind === "oval") {
      const rx = eye.rx * L * fit;
      const ry = eye.ry * L * fit;
      inner = `<ellipse cx="0" cy="0" rx="${round2(rx)}" ry="${round2(ry)}" fill="var(--aa-ink)" />`;
    } else if (eye.kind === "arc") {
      const points = eye.points;
      const d = `M${round2(points[0][0] * L * fit)} ${round2(points[0][1] * L * fit)} Q${round2(
        points[1][0] * L * fit,
      )} ${round2(points[1][1] * L * fit)} ${round2(points[2][0] * L * fit)} ${round2(
        points[2][1] * L * fit,
      )}`;
      inner = `<path d="${d}" fill="none" stroke="var(--aa-ink)" stroke-width="${round2(
        eye.width * L * fit,
      )}" stroke-linecap="round" />`;
    } else {
      const width = eye.width * L * fit;
      const height = eye.height * L * fit;
      inner = `<rect x="${round2(-width / 2)}" y="${round2(-height / 2)}" width="${round2(
        width,
      )}" height="${round2(height)}" rx="${round2(width / 2)}" fill="var(--aa-ink)" />`;
    }
    markups.push(
      `<g class="aa-eye" transform="translate(${round2(cx)} ${round2(cy)}) rotate(${round2(
        tilt,
      )})"><g class="aa-eye-shape">${inner}</g></g>`,
    );
  }
  return markups.join("");
}

/* -------------------------------------------------------------------------- */
/* Effect markup                                                              */
/* -------------------------------------------------------------------------- */

function effectLayer() {
  const center = L;
  const orbitDots = Array.from({ length: 3 }, (_, index) => {
    const angle = (index / 3) * TAU - Math.PI / 2;
    return `<circle cx="${round2(center + Math.cos(angle) * 126)}" cy="${round2(
      center + Math.sin(angle) * 126,
    )}" r="5.5" fill="var(--aa-effect)" opacity="${0.9 - index * 0.18}" />`;
  }).join("");
  const streamDots = Array.from({ length: 4 }, (_, index) => {
    const angle = (index / 4) * TAU;
    return `<circle class="aa-stream-dot" style="--aa-i:${index}" cx="${round2(
      center + Math.cos(angle) * 126,
    )}" cy="${round2(center + Math.sin(angle) * 126)}" r="4.5" fill="var(--aa-effect)" />`;
  }).join("");
  const spawnDots = Array.from({ length: 8 }, (_, index) => {
    const angle = (index / 8) * TAU;
    const dx = Math.cos(angle) * -22;
    const dy = Math.sin(angle) * -22;
    return `<circle class="aa-spawn-dot" cx="${round2(
      center + Math.cos(angle) * 138,
    )}" cy="${round2(center + Math.sin(angle) * 138)}" r="4" fill="var(--aa-effect)" style="--aa-i:${index};--aa-dx:${round2(
      dx,
    )}px;--aa-dy:${round2(dy)}px" />`;
  }).join("");
  const waveBars = Array.from({ length: 5 }, (_, index) => {
    const x = center - 34 + index * 17;
    return `<rect class="aa-wave-bar" style="--aa-i:${index}" x="${x}" y="${center + 122}" width="7" height="24" rx="3.5" fill="var(--aa-effect)" />`;
  }).join("");
  const confetti = Array.from({ length: 12 }, (_, index) => {
    const colors = ["#D7FF5F", "#FF781C", "#FF5EB1", "#2A92FE", "#00C972", "#FFAF38"];
    const x = center - 92 + ((index * 37) % 184);
    const y = center - 96 + ((index * 53) % 150);
    const rotate = (index * 47) % 180;
    return `<rect class="aa-confetti-piece" style="--aa-i:${index}" x="${round2(x)}" y="${round2(
      y,
    )}" width="7" height="12" rx="1.5" fill="${colors[index % colors.length]}" transform="rotate(${rotate} ${round2(
      x,
    )} ${round2(y)})" />`;
  }).join("");
  const sparkles = [
    [center - 92, center - 86, 0.75],
    [center + 88, center - 72, 0.55],
    [center + 72, center + 78, 0.68],
    [center - 76, center + 82, 0.48],
  ]
    .map(
      ([x, y, scale], index) =>
        `<path class="aa-sparkle-star" style="--aa-i:${index}" d="M0 -12 C2 -4 4 -2 12 0 C4 2 2 4 0 12 C-2 4 -4 2 -12 0 C-4 -2 -2 -4 0 -12Z" fill="var(--aa-effect)" transform="translate(${round2(
          x,
        )} ${round2(y)}) scale(${scale})" />`,
    )
    .join("");
  return `
    <g class="aa-fx-layer">
      <g class="aa-effect aa-effect-dots" transform="rotate(0 ${center} ${center})">${orbitDots}</g>
      <g class="aa-effect aa-effect-stream">${streamDots}</g>
      <g class="aa-effect aa-effect-orbit">
        <circle cx="${center}" cy="${center}" r="132" fill="none" stroke="var(--aa-effect)" stroke-opacity=".16" stroke-width="1.2" stroke-dasharray="2 8" />
        <g class="aa-orbit-rotor">${orbitDots}</g>
      </g>
      <g class="aa-effect aa-effect-radar">
        <circle class="aa-radar-ring" cx="${center}" cy="${center}" r="92" fill="none" stroke="var(--aa-effect)" stroke-width="2" />
        <circle class="aa-radar-ring" style="--aa-i:1" cx="${center}" cy="${center}" r="92" fill="none" stroke="var(--aa-effect)" stroke-width="1.4" />
        <circle class="aa-radar-ring" style="--aa-i:2" cx="${center}" cy="${center}" r="92" fill="none" stroke="var(--aa-effect)" stroke-width="1" />
        <line class="aa-radar-sweep" x1="${center}" y1="${center}" x2="${center}" y2="${center - 92}" stroke="var(--aa-effect)" stroke-width="2" stroke-linecap="round" />
      </g>
      <g class="aa-effect aa-effect-progress">
        <circle cx="${center}" cy="${center}" r="138" fill="none" stroke="var(--aa-effect)" stroke-opacity=".14" stroke-width="4" />
        <circle class="aa-progress-arc" cx="${center}" cy="${center}" r="138" fill="none" stroke="var(--aa-effect)" stroke-width="4" stroke-linecap="round" stroke-dasharray="867.08" stroke-dashoffset="220" transform="rotate(-90 ${center} ${center})" />
      </g>
      <g class="aa-effect aa-effect-spawn">${spawnDots}</g>
      <g class="aa-effect aa-effect-wave">${waveBars}</g>
      <g class="aa-effect aa-effect-send">
        <circle class="aa-send-dot" cx="${center + 100}" cy="${center - 96}" r="6" fill="var(--aa-effect)" />
        <path class="aa-send-trail" d="M${center + 74} ${center - 70} L${center + 96} ${center - 92}" stroke="var(--aa-effect)" stroke-width="2" stroke-linecap="round" opacity=".45" />
      </g>
      <g class="aa-effect aa-effect-receive">
        <circle class="aa-receive-dot" cx="${center + 100}" cy="${center + 92}" r="6" fill="var(--aa-effect)" />
        <path class="aa-receive-trail" d="M${center + 76} ${center + 68} L${center + 96} ${center + 88}" stroke="var(--aa-effect)" stroke-width="2" stroke-linecap="round" opacity=".45" />
      </g>
      <g class="aa-effect aa-effect-dock">
        <path class="aa-dock-arrow" d="M${center - 24} ${center + 126} L${center} ${center + 102} L${center + 24} ${center + 126}" fill="none" stroke="var(--aa-effect)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        <path class="aa-dock-arrow" style="--aa-i:1" d="M${center - 18} ${center + 144} L${center} ${center + 126} L${center + 18} ${center + 144}" fill="none" stroke="var(--aa-effect)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      </g>
      <g class="aa-effect aa-effect-ball">
        <circle class="aa-ball" cx="${center + 106}" cy="${center + 102}" r="8" fill="var(--aa-effect)" />
        <ellipse class="aa-ball-shadow" cx="${center + 106}" cy="${center + 118}" rx="11" ry="3" fill="var(--aa-effect)" opacity=".18" />
      </g>
      <g class="aa-effect aa-effect-pencil">
        <path class="aa-pencil" d="M${center - 28} ${center + 112} L${center + 36} ${center + 112} M${center - 12} ${center + 122} L${center + 44} ${center + 122}" stroke="var(--aa-effect)" stroke-width="3" stroke-linecap="round" />
        <path class="aa-pencil-tip" d="M${center + 44} ${center + 92} L${center + 58} ${center + 78} L${center + 66} ${center + 86} L${center + 52} ${center + 100} Z" fill="var(--aa-effect)" />
      </g>
      <g class="aa-effect aa-effect-bang">
        <circle cx="${center + 102}" cy="${center - 96}" r="20" fill="var(--aa-effect)" />
        <path d="M${center + 102} ${center - 108} L${center + 102} ${center - 94} M${center + 102} ${center - 87} L${center + 102} ${center - 86}" stroke="var(--aa-bang-ink)" stroke-width="3.2" stroke-linecap="round" />
      </g>
      <g class="aa-effect aa-effect-standby">
        <circle class="aa-standby-ring" cx="${center}" cy="${center}" r="126" fill="none" stroke="var(--aa-effect)" stroke-width="1.5" />
        <line x1="${center - 18}" y1="${center - 70}" x2="${center}" y2="${center - 96}" stroke="var(--aa-effect)" stroke-width="3" stroke-linecap="round" />
        <circle cx="${center}" cy="${center - 96}" r="3.5" fill="var(--aa-effect)" />
      </g>
      <g class="aa-effect aa-effect-ring">
        <circle class="aa-pulse-ring" cx="${center}" cy="${center}" r="126" fill="none" stroke="var(--aa-effect)" stroke-width="1.4" />
        <circle class="aa-pulse-ring" style="--aa-i:1" cx="${center}" cy="${center}" r="126" fill="none" stroke="var(--aa-effect)" stroke-width="1" />
      </g>
      <g class="aa-effect aa-effect-zzz">
        <text class="aa-zzz aa-zzz-1" x="${center + 88}" y="${center - 54}" fill="var(--aa-effect)" font-size="24" font-family="ui-rounded, sans-serif" font-weight="700">z</text>
        <text class="aa-zzz aa-zzz-2" x="${center + 108}" y="${center - 80}" fill="var(--aa-effect)" font-size="18" font-family="ui-rounded, sans-serif" font-weight="700">z</text>
        <text class="aa-zzz aa-zzz-3" x="${center + 124}" y="${center - 102}" fill="var(--aa-effect)" font-size="14" font-family="ui-rounded, sans-serif" font-weight="700">z</text>
      </g>
      <g class="aa-effect aa-effect-confetti">${confetti}</g>
      <g class="aa-effect aa-effect-sparkle">${sparkles}</g>
      <g class="aa-effect aa-effect-hum">
        <path class="aa-hum-line" d="M${center - 116} ${center - 34} Q${center - 134} ${center} ${center - 116} ${center + 34}" fill="none" stroke="var(--aa-effect)" stroke-width="2" stroke-linecap="round" />
        <path class="aa-hum-line" style="--aa-i:1" d="M${center + 116} ${center - 34} Q${center + 134} ${center} ${center + 116} ${center + 34}" fill="none" stroke="var(--aa-effect)" stroke-width="2" stroke-linecap="round" />
      </g>
      <g class="aa-effect aa-effect-notify">
        <circle class="aa-notify-badge" cx="${center + 102}" cy="${center - 96}" r="13" fill="var(--aa-notify)" />
        <circle cx="${center + 102}" cy="${center - 96}" r="4" fill="#fff" />
      </g>
      <g class="aa-effect aa-effect-drag">
        <path class="aa-drag-line" d="M${center - 138} ${center + 42} L${center - 114} ${center + 42}" stroke="var(--aa-effect)" stroke-width="2" stroke-linecap="round" />
        <path class="aa-drag-line" style="--aa-i:1" d="M${center + 114} ${center - 42} L${center + 138} ${center - 42}" stroke="var(--aa-effect)" stroke-width="2" stroke-linecap="round" />
      </g>
    </g>
  `;
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                     */
/* -------------------------------------------------------------------------- */

let uidCounter = 0;

const DEFAULTS = {
  shape: "blob",
  color: "orange",
  theme: "dark",
  state: "idle",
  expression: "auto",
  size: 320,
  followPointer: true,
  hoverTilt: true,
  gazeStrength: 1,
  interactive: true,
  draggable: true,
  clickAction: "bounce",
  depth: 0.65,
  glow: 0.35,
  ring: false,
  shadow: true,
  effects: true,
  autoBlink: true,
  idleMotion: true,
  speed: 1,
  intensity: 1,
  paused: false,
  reducedMotion: false,
  autoAdvance: false,
  eyeColor: null,
  eyeY: null,
  ariaLabel: "智能体头像",
  onPoke: null,
  onStateChange: null,
};

class AgentAvatarEngine {
  constructor(host, options = {}) {
    if (!host) throw new Error("AgentAvatarEngine requires a host element");
    this.host = host;
    this.uid = `aa-${++uidCounter}`;
    this.options = { ...DEFAULTS, ...options };
    this.t = 0;
    this.lastFrame = 0;
    this.gaze = { x: 0, y: 0 };
    this.targetGaze = { x: 0, y: 0 };
    this.pokes = [];
    this.dragging = false;
    this.dragOffset = { x: 0, y: 0, vx: 0, vy: 0 };
    this.pointerDown = null;
    this.hovering = false;
    this.blinkStart = -1;
    this.nextBlinkAt = 2.2 + Math.random() * 2.8;
    this.stateStartedAt = 0;
    this.raf = 0;
    this.isDestroyed = false;
    this.boundFrame = this.frame.bind(this);
    this.boundPointerMove = this.onPointerMove.bind(this);
    this.boundPointerDown = this.onPointerDown.bind(this);
    this.boundPointerUp = this.onPointerUp.bind(this);
    this.boundPointerLeave = this.onPointerLeave.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
    this.boundWindowPointerMove = this.onWindowPointerMove.bind(this);
    this.render();
    this.attach();
    this.start();
  }

  get shape() {
    return SHAPES.some((shape) => shape.id === this.options.shape) ? this.options.shape : "blob";
  }

  get state() {
    return STATES.some((state) => state.id === this.options.state) ? this.options.state : "idle";
  }

  get theme() {
    return resolveTheme(this.options.theme);
  }

  get colorValue() {
    return resolveColor(this.options.color, this.theme);
  }

  get inkValue() {
    return sanitizeColor(this.options.eyeColor, resolveInk(this.colorValue));
  }

  get expressionName() {
    if (this.options.expression && this.options.expression !== "auto") {
      return EXPRESSIONS[this.options.expression] ? this.options.expression : "neutral";
    }
    return STATE_EXPRESSION[this.state] ?? "neutral";
  }

  get effectNames() {
    if (!this.options.effects) return [];
    return STATE_EFFECTS[this.state] ?? [];
  }

  render() {
    if (this.root) this.detach();
    const shape = getShape(this.shape);
    const color = this.colorValue;
    const ink = this.inkValue;
    const effects = this.effectNames;
    const effectClass = effects.map((effect) => `aa-show-${effect}`).join(" ");
    const uid = this.uid;
    const size = typeof this.options.size === "number" ? `${this.options.size}px` : this.options.size;
    const depth = clamp(this.options.depth, 0, 1);
    const glow = clamp(this.options.glow, 0, 1);
    const isDim = this.state === "blocked" || this.state === "powering-down";
    const isPowerDown = this.state === "powering-down";
    const body = `<path class="aa-body" d="${shape.path}" fill="var(--aa-color)" />`;
    const sheen = `<path class="aa-body-sheen" d="${shape.path}" fill="url(#${uid}-sheen)" />`;
    const shade = `<path class="aa-body-shade" d="${shape.path}" fill="url(#${uid}-shade)" />`;
    const rim = `<path class="aa-body-rim" d="${shape.path}" fill="none" stroke="var(--aa-rim)" stroke-width="1.4" />`;
    const stem =
      this.shape === "pumpkin"
        ? `<path d="M${L - 8} ${L - 94} C${L - 10} ${L - 116}, ${L + 8} ${L - 122}, ${L + 14} ${L - 132} L${L + 28} ${L - 126} C${L + 20} ${L - 112}, ${L + 18} ${L - 100}, ${L + 14} ${L - 90} Z" fill="#5B7C2E" />`
        : "";
    const markup = `
        <div class="aa-root ${effectClass} ${isDim ? "aa-dim" : ""} ${isPowerDown ? "aa-powering-down" : ""}" data-state="${this.state}" data-shape="${this.shape}" data-theme="${this.theme}" tabindex="${this.options.interactive ? "0" : "-1"}" role="button" aria-label="${escapeAttribute(this.options.ariaLabel)}" style="--aa-size:${size};--aa-color:${color};--aa-ink:${ink};--aa-effect:${ink};--aa-rim:${mixRgba(ink, 0.16)};--aa-bang-ink:${resolveInk(ink)};--aa-notify:#FF4D4D;--aa-depth:${depth};--aa-glow:${glow};--aa-blink:1;--aa-rx:0deg;--aa-ry:0deg;--aa-tx:0px;--aa-ty:0px;--aa-sx:1;--aa-sy:1;--aa-eye-x:0px;--aa-eye-y:0px;">
        <div class="aa-glow" aria-hidden="true"></div>
        ${this.options.shadow ? '<div class="aa-ground-shadow" aria-hidden="true"></div>' : ""}
        ${this.options.ring ? '<div class="aa-halo" aria-hidden="true"></div>' : ""}
        <div class="aa-stage" aria-hidden="true">
          <div class="aa-tilt">
            <svg class="aa-svg" viewBox="${VIEWBOX}" xmlns="http://www.w3.org/2000/svg" overflow="visible">
              <defs>
                <radialGradient id="${uid}-sheen" cx="34%" cy="24%" r="72%">
                  <stop offset="0%" stop-color="#FFFFFF" stop-opacity=".48" />
                  <stop offset="42%" stop-color="#FFFFFF" stop-opacity=".12" />
                  <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0" />
                </radialGradient>
                <radialGradient id="${uid}-shade" cx="72%" cy="82%" r="72%">
                  <stop offset="0%" stop-color="#000000" stop-opacity=".26" />
                  <stop offset="58%" stop-color="#000000" stop-opacity=".08" />
                  <stop offset="100%" stop-color="#000000" stop-opacity="0" />
                </radialGradient>
              </defs>
              ${effectLayer()}
              ${body}
              ${sheen}
              ${shade}
              ${rim}
              ${stem}
              <g class="aa-eyes">${eyeMarkup(this.expressionName, shape, this.options)}</g>
            </svg>
          </div>
        </div>
      </div>
    `;
    this.host.innerHTML = markup;
    this.root = this.host.querySelector(".aa-root");
    this.tilt = this.host.querySelector(".aa-tilt");
    this.progressArc = this.host.querySelector(".aa-progress-arc");
    this.applyStaticStyle();
  }

  update(next = {}) {
    const previous = this.options;
    const merged = { ...previous, ...next };
    const needsRender =
      merged.shape !== previous.shape ||
      merged.color !== previous.color ||
      merged.theme !== previous.theme ||
      merged.state !== previous.state ||
      merged.expression !== previous.expression ||
      merged.effects !== previous.effects ||
      merged.ring !== previous.ring ||
      merged.shadow !== previous.shadow ||
      merged.followPointer !== previous.followPointer ||
      merged.eyeColor !== previous.eyeColor ||
      merged.eyeY !== previous.eyeY;
    this.options = merged;
    if (merged.state !== previous.state) {
      this.stateStartedAt = this.t;
      this.options.onStateChange?.(merged.state);
    }
    if (needsRender) {
      this.render();
      this.attach();
    } else {
      this.applyStaticStyle();
    }
    if (merged.state !== previous.state && this.options.autoAdvance) {
      // auto-advance is handled in the frame loop
    }
  }

  applyStaticStyle() {
    if (!this.root) return;
    const size = typeof this.options.size === "number" ? `${this.options.size}px` : this.options.size;
    this.root.style.setProperty("--aa-size", size);
    this.root.style.setProperty("--aa-color", this.colorValue);
    this.root.style.setProperty("--aa-ink", this.inkValue);
    this.root.style.setProperty("--aa-effect", this.inkValue);
    this.root.style.setProperty("--aa-depth", String(clamp(this.options.depth, 0, 1)));
    this.root.style.setProperty("--aa-glow", String(clamp(this.options.glow, 0, 1)));
    this.root.setAttribute("data-theme", this.theme);
    this.root.setAttribute("aria-label", this.options.ariaLabel);
    this.root.setAttribute("tabindex", this.options.interactive ? "0" : "-1");
    this.root.classList.toggle("aa-paused", Boolean(this.options.paused));
    this.root.classList.toggle("aa-reduced", Boolean(this.options.reducedMotion));
  }

  setState(state) {
    if (state === this.state) return;
    this.options.state = state;
    this.stateStartedAt = this.t;
    this.render();
    this.attach();
    this.options.onStateChange?.(state);
  }

  setExpression(expression) {
    if (expression === this.options.expression) return;
    this.options.expression = expression;
    this.render();
    this.attach();
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
      duration: resolved === "spin" ? 0.9 : resolved === "bounce" ? 0.62 : 0.5,
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
    this.host.innerHTML = "";
  }

  frame(now) {
    if (this.isDestroyed) return;
    const seconds = now / 1000;
    const dt = this.lastFrame === 0 ? 0.016 : clamp(seconds - this.lastFrame, 0.001, 0.05);
    this.lastFrame = seconds;
    if (!this.options.paused) {
      this.t += dt * clamp(this.options.speed, 0.1, 3);
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
    if (this.dragging) {
      this.targetGaze = {
        x: clamp(this.dragOffset.x / 60, -1, 1),
        y: clamp(-this.dragOffset.y / 60, -1, 1),
      };
    }
    const smoothing = this.options.reducedMotion ? 1 : 1 - Math.exp(-dt * 10);
    this.gaze.x = lerp(this.gaze.x, this.targetGaze.x, smoothing);
    this.gaze.y = lerp(this.gaze.y, this.targetGaze.y, smoothing);
  }

  updateBlink(dt) {
    if (!this.options.autoBlink || this.options.reducedMotion) {
      this.setVar("--aa-blink", 1);
      return;
    }
    if (["sleeping", "drowsy", "bored"].includes(this.state)) {
      this.setVar("--aa-blink", 0.12);
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
        this.setVar("--aa-blink", 1);
      } else {
        const amount = Math.sin(clamp(progress, 0, 1) * Math.PI);
        this.setVar("--aa-blink", 1 - amount * 0.93);
      }
    }
  }

  updatePokes() {
    this.pokes = this.pokes.filter((poke) => this.t - poke.start < poke.duration + 0.1);
  }

  updateAutoAdvance() {
    if (!this.options.autoAdvance) return;
    const recipe = AUTO_NEXT[this.state];
    if (!recipe) return;
    if (this.t - this.stateStartedAt >= recipe.holdSeconds) {
      this.setState(recipe.next);
    }
  }

  applyMotion() {
    if (!this.root || !this.tilt) return;
    const motion = STATE_MOTION[this.state] ?? STATE_MOTION.idle;
    const intensity = clamp(this.options.intensity, 0, 2);
    const gazeStrength = clamp(this.options.gazeStrength ?? 1, 0, 2);
    const idle = this.options.idleMotion && !this.options.reducedMotion ? 1 : 0;
    const time = this.t;
    let rx = 0;
    let ry = 0;
    let tx = 0;
    let ty = 0;
    let sx = 1;
    let sy = 1;
    let opacity = 1;

    if (idle) {
      ty += Math.sin(time * 1.45) * (motion.bob ?? 1) * intensity;
      tx += Math.sin(time * 0.92) * (motion.sway ?? 0.4) * intensity;
      rx += Math.sin(time * 0.78 + 1.2) * (motion.tiltX ?? 0) * intensity;
      ry += Math.sin(time * 0.64) * (motion.tilt ?? 0.4) * intensity;
    }
    if (this.options.hoverTilt) {
      rx += -this.gaze.y * 24 * gazeStrength;
      ry += this.gaze.x * 32 * gazeStrength;
      tx += this.gaze.x * 12 * gazeStrength;
      ty += this.gaze.y * 6 * gazeStrength;
    }
    if (motion.jitter) {
      tx += Math.sin(time * 23) * motion.jitter * intensity;
      ty += Math.cos(time * 19) * motion.jitter * 0.6 * intensity;
    }
    if (motion.shake) {
      tx += Math.sin(time * 32) * motion.shake * intensity;
    }
    if (motion.bounce) {
      const bounce = Math.abs(Math.sin(time * 3.1));
      ty -= bounce * 12 * motion.bounce * intensity;
      sx += bounce * 0.025 * motion.bounce;
      sy -= bounce * 0.04 * motion.bounce;
    }
    if (motion.breathe) {
      const breathe = Math.sin(time * 1.25) * 0.5 + 0.5;
      sx += breathe * 0.012 * motion.breathe;
      sy += breathe * 0.018 * motion.breathe;
    }
    if (motion.pulse) {
      const pulse = Math.sin(time * 2.6) * 0.5 + 0.5;
      sx += pulse * 0.018 * motion.pulse;
      sy += pulse * 0.018 * motion.pulse;
    }
    if (motion.turn) {
      ry += Math.sin(time * 0.7) * 18 * motion.turn;
    }
    if (motion.spin) {
      ry += time * 48 * motion.spin;
    }
    if (motion.powerDown) {
      opacity = clamp(1 - (time - this.stateStartedAt) * 0.12, 0.28, 1);
      sy *= 0.985;
    }
    if (motion.dragLean) {
      rx += this.gaze.y * 6;
      ry += this.gaze.x * 8;
    }

    for (const poke of this.pokes) {
      const progress = clamp((this.t - poke.start) / poke.duration, 0, 1);
      const eased = easeOutCubic(progress);
      if (poke.action === "spin") {
        ry += 360 * poke.turns * eased;
      } else if (poke.action === "bounce") {
        const lift = Math.sin(progress * Math.PI) * 22;
        ty -= lift;
        const squash = Math.sin(progress * Math.PI) * 0.08;
        sx += squash;
        sy -= squash;
      } else if (poke.action === "nod") {
        rx += Math.sin(progress * Math.PI * 2) * 14 * (1 - progress * 0.35);
      }
    }

    if (this.dragging) {
      tx += this.dragOffset.x * 0.42;
      ty += this.dragOffset.y * 0.42;
      rx += this.dragOffset.y * -0.09;
      ry += this.dragOffset.x * 0.11;
    } else {
      this.dragOffset.x = lerp(this.dragOffset.x, 0, 0.18);
      this.dragOffset.y = lerp(this.dragOffset.y, 0, 0.18);
      tx += this.dragOffset.x;
      ty += this.dragOffset.y;
    }

    this.setVar("--aa-rx", `${round2(rx)}deg`);
    this.setVar("--aa-ry", `${round2(ry)}deg`);
    this.setVar("--aa-tx", `${round2(tx)}px`);
    this.setVar("--aa-ty", `${round2(ty)}px`);
    this.setVar("--aa-sx", String(round2(sx)));
    this.setVar("--aa-sy", String(round2(sy)));
    this.setVar("--aa-eye-x", `${round2(this.gaze.x * 15 * gazeStrength)}px`);
    this.setVar("--aa-eye-y", `${round2(-this.gaze.y * 10 * gazeStrength)}px`);
    this.root.style.opacity = String(round2(opacity));

    if (this.progressArc) {
      const progress = (Math.sin(time * 1.1) * 0.5 + 0.5) * 0.78 + 0.05;
      this.progressArc.setAttribute("stroke-dashoffset", String(round2(867.08 * (1 - progress))));
    }
  }

  setVar(name, value) {
    if (this.root) this.root.style.setProperty(name, value);
  }

  attach() {
    if (!this.root) return;
    this.root.addEventListener("pointermove", this.boundPointerMove, { passive: true });
    this.root.addEventListener("pointerdown", this.boundPointerDown);
    this.root.addEventListener("pointerup", this.boundPointerUp);
    this.root.addEventListener("pointercancel", this.boundPointerUp);
    this.root.addEventListener("pointerleave", this.boundPointerLeave);
    this.root.addEventListener("keydown", this.boundKeyDown);
    if (this.options.followPointer) {
      window.addEventListener("pointermove", this.boundWindowPointerMove, { passive: true });
    }
  }

  detach() {
    if (!this.root) return;
    this.root.removeEventListener("pointermove", this.boundPointerMove);
    this.root.removeEventListener("pointerdown", this.boundPointerDown);
    this.root.removeEventListener("pointerup", this.boundPointerUp);
    this.root.removeEventListener("pointercancel", this.boundPointerUp);
    this.root.removeEventListener("pointerleave", this.boundPointerLeave);
    this.root.removeEventListener("keydown", this.boundKeyDown);
    window.removeEventListener("pointermove", this.boundWindowPointerMove);
  }

  onPointerMove(event) {
    if (!this.root) return;
    const rect = this.root.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    const y = -((event.clientY - rect.top) / rect.height - 0.5) * 2;
    this.hovering = true;
    if (this.dragging) {
      this.dragOffset.x = clamp(event.clientX - this.pointerDown.startX, -80, 80);
      this.dragOffset.y = clamp(event.clientY - this.pointerDown.startY, -80, 80);
    } else {
      this.targetGaze = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    }
  }

  onWindowPointerMove(event) {
    if (!this.options.followPointer || !this.root || this.dragging) return;
    const rect = this.root.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const radius = Math.max(rect.width, rect.height) * 1.25;
    this.targetGaze = {
      x: clamp((event.clientX - centerX) / radius, -1, 1),
      y: clamp(-(event.clientY - centerY) / radius, -1, 1),
    };
  }

  onPointerDown(event) {
    if (!this.options.interactive || !this.root) return;
    this.root.focus({ preventScroll: true });
    this.pointerDown = {
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      time: performance.now(),
    };
    if (this.options.draggable) {
      this.dragging = true;
      this.root.setPointerCapture?.(event.pointerId);
      this.root.classList.add("aa-is-dragging");
    }
  }

  onPointerUp(event) {
    if (!this.pointerDown) return;
    const dx = event.clientX - this.pointerDown.startX;
    const dy = event.clientY - this.pointerDown.startY;
    const moved = Math.hypot(dx, dy) > 6;
    this.dragging = false;
    this.root?.classList.remove("aa-is-dragging");
    this.root?.releasePointerCapture?.(event.pointerId);
    if (!moved) this.poke(this.options.clickAction);
    this.pointerDown = null;
  }

  onPointerLeave() {
    this.hovering = false;
    this.dragging = false;
    this.root?.classList.remove("aa-is-dragging");
    if (!this.options.followPointer) {
      this.targetGaze = { x: 0, y: 0 };
    }
  }

  onKeyDown(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.poke(this.options.clickAction);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      this.targetGaze = { x: -0.9, y: 0 };
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      this.targetGaze = { x: 0.9, y: 0 };
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.targetGaze = { x: 0, y: 0.9 };
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      this.targetGaze = { x: 0, y: -0.9 };
    }
  }

  getStaticSvg(size = 512) {
    const shape = getShape(this.shape);
    const color = this.colorValue;
    const ink = this.inkValue;
    const uid = `static-${this.uid}`;
    const depth = clamp(this.options.depth, 0, 1);
    const eyes = eyeMarkup(this.expressionName, shape, this.options);
    const stem =
      this.shape === "pumpkin"
        ? `<path d="M${L - 8} ${L - 94} C${L - 10} ${L - 116}, ${L + 8} ${L - 122}, ${L + 14} ${L - 132} L${L + 28} ${L - 126} C${L + 20} ${L - 112}, ${L + 18} ${L - 100}, ${L + 14} ${L - 90} Z" fill="#5B7C2E" />`
        : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${VIEWBOX}" role="img" aria-label="${escapeAttribute(
      this.options.ariaLabel,
    )}">
  <defs>
    <radialGradient id="${uid}-sheen" cx="34%" cy="24%" r="72%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity=".48"/>
      <stop offset="42%" stop-color="#FFFFFF" stop-opacity=".12"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${uid}-shade" cx="72%" cy="82%" r="72%">
      <stop offset="0%" stop-color="#000000" stop-opacity=".26"/>
      <stop offset="58%" stop-color="#000000" stop-opacity=".08"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <style>
    .aa-body{fill:${color}}
    .aa-body-sheen{opacity:${round2(depth * 0.62)}}
    .aa-body-shade{opacity:${round2(depth * 0.46)}}
    .aa-body-rim{opacity:${round2(depth * 0.52)}}
    .aa-ink{fill:${ink}}
  </style>
  <path class="aa-body" d="${shape.path}"/>
  <path class="aa-body-sheen" d="${shape.path}" fill="url(#${uid}-sheen)"/>
  <path class="aa-body-shade" d="${shape.path}" fill="url(#${uid}-shade)"/>
  <path class="aa-body-rim" d="${shape.path}" fill="none" stroke="${mixRgba(ink, 0.16)}" stroke-width="1.4"/>
  ${stem}
  <g class="aa-ink">${eyes.replaceAll("var(--aa-ink)", ink)}</g>
</svg>`;
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

function mixRgba(color, alpha) {
  const rgb = hexToRgb(color);
  if (!rgb) return `rgba(255,255,255,${alpha})`;
  return `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(
    rgb[2] * 255,
  )}, ${alpha})`;
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export {
  AgentAvatarEngine,
  COLORS,
  DEFAULTS,
  EXPRESSIONS,
  SHAPES,
  STATES,
  STATE_GROUPS,
  STATE_EXPRESSION,
  STATE_EFFECTS,
  STATE_MOTION,
  AUTO_NEXT,
  effectLayer,
  eyeMarkup,
  getShape,
  hashColor,
  hashShape,
  resolveColor,
  resolveInk,
  resolveTheme,
};
