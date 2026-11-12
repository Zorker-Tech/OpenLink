export function rootPoint(root, element, xRatio = 0.5, yRatio = 0.55) {
    const rootRect = root.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
        x: rect.left - rootRect.left + rect.width * xRatio,
        y: rect.top - rootRect.top + rect.height * yRatio,
    };
}
export function findTarget(root, name) {
    const matches = [...root.querySelectorAll(`[data-zbd-target="${name}"]`)];
    return matches.find((element) => element.closest('.zbd-screen-layer')) ?? matches[0] ?? null;
}
export function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function waitForTarget(root, name, timeoutMs = 15_000) {
    const start = Date.now();
    for (;;) {
        const target = findTarget(root, name);
        if (target)
            return target;
        if (Date.now() - start > timeoutMs)
            throw new Error(`Demo target never appeared: ${name}`);
        await wait(120);
    }
}
