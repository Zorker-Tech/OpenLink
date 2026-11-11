var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
export function rootPoint(root, element, xRatio = 0.5, yRatio = 0.55) {
    const rootRect = root.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
        x: rect.left - rootRect.left + rect.width * xRatio,
        y: rect.top - rootRect.top + rect.height * yRatio,
    };
}
export function findTarget(root, name) {
    var _a, _b;
    const matches = [...root.querySelectorAll(`[data-zbd-target="${name}"]`)];
    return (_b = (_a = matches.find((element) => element.closest('.zbd-screen-layer'))) !== null && _a !== void 0 ? _a : matches[0]) !== null && _b !== void 0 ? _b : null;
}
export function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function waitForTarget(root_1, name_1) {
    return __awaiter(this, arguments, void 0, function* (root, name, timeoutMs = 15000) {
        const start = Date.now();
        for (;;) {
            const target = findTarget(root, name);
            if (target)
                return target;
            if (Date.now() - start > timeoutMs)
                throw new Error(`Demo target never appeared: ${name}`);
            yield wait(120);
        }
    });
}
