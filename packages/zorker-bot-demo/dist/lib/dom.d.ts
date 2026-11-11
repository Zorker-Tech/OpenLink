export declare function rootPoint(root: HTMLElement, element: Element, xRatio?: number, yRatio?: number): {
    x: number;
    y: number;
};
export declare function findTarget(root: HTMLElement, name: string): HTMLElement;
export declare function wait(ms: number): Promise<void>;
export declare function waitForTarget(root: HTMLElement, name: string, timeoutMs?: number): Promise<HTMLElement>;
//# sourceMappingURL=dom.d.ts.map