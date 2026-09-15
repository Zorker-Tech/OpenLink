// Shared primitives for the dotted 3D thought-orbs. Ported from inkform
// (PlotterLab's HalftoneSphere lineage): honestly 3D — rotated,
// depth-shaded, z-sorted. Depth is carried by dot size and ink weight
// alone. Plain 2D canvas fills only: no ctx.filter, no SVG filters, so
// every mode renders identically in Chrome, Safari and Firefox.
export function lerp(a, b, f) {
    return a + (b - a) * f;
}
export function frac(x) {
    return x - Math.floor(x);
}
/** Value noise on a 2D lattice — smooth, deterministic, cheap. */
export function vnoise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let fx = x - xi;
    let fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = hashD(xi, yi);
    const b = hashD(xi + 1, yi);
    const c = hashD(xi, yi + 1);
    const d = hashD(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
/** Deterministic hash in [0, 1). */
export function hashD(a, b) {
    const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return h - Math.floor(h);
}
/** Stable directions on a unit sphere (Fibonacci lattice). */
export function fibDir(i, n) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - (2 * (i + 0.5)) / n;
    const rad = Math.sqrt(1 - y * y);
    const a = i * golden;
    return [rad * Math.cos(a), y, rad * Math.sin(a)];
}
/** Shortest signed angular distance, wrapped to (-π, π]. */
export function angleDelta(a, b) {
    return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}
/** Shared spin + tilt + orthographic projection. */
export function makeProj(yaw, tilt, cx, cy, scale) {
    const st = Math.sin(tilt);
    const ct = Math.cos(tilt);
    const sy = Math.sin(yaw);
    const cyw = Math.cos(yaw);
    return (x, y, z) => {
        const x1 = x * cyw + z * sy;
        const z1 = -x * sy + z * cyw;
        const y1 = y * ct - z1 * st;
        const z2 = y * st + z1 * ct;
        return [cx + x1 * scale, cy - y1 * scale, z2];
    };
}
/**
 * Painter: z-sort far→near, matte grayscale dots. On dark substrates the
 * ink value is mirrored (1 - white) so near dots read bright — the same
 * depth language on an inverted substrate.
 */
export function paint(ctx, dots, dark, rMin = 0.3) {
    dots.sort((a, b) => a.z - b.z);
    for (const d of dots) {
        const alpha = d.a ?? 1;
        if (alpha < 0.02)
            continue;
        const w = Math.min(1, Math.max(0, d.white));
        const g = Math.round((dark ? 1 - w : w) * 255);
        ctx.fillStyle = `rgba(${g},${g},${g},${alpha})`;
        ctx.beginPath();
        ctx.arc(d.x, d.y, Math.max(rMin, d.r), 0, Math.PI * 2);
        ctx.fill();
    }
}
/** Stroke pass for edge-based modes. Runs before `paint` so nodes sit on top. */
export function paintLines(ctx, lines, dark) {
    for (const l of lines) {
        const alpha = l.a ?? 1;
        if (alpha < 0.02)
            continue;
        const w = Math.min(1, Math.max(0, l.white));
        const g = Math.round((dark ? 1 - w : w) * 255);
        ctx.strokeStyle = `rgba(${g},${g},${g},${alpha})`;
        ctx.lineWidth = l.w;
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
    }
}
/**
 * Dot radii were tuned for a 300pt frame; sub-linear scaling keeps small
 * spinners legible. Lower pow = radii shrink less with size.
 */
export function radiusScale(size, pow) {
    return (size / 300) ** pow;
}
