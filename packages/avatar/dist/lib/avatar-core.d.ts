declare function O2(e: any): {
    attach: (P: any) => () => void;
    update: (P: any) => void;
    setState: (P: any) => void;
    setBody: (P: any) => void;
    setPlaying: (P: any) => void;
    setExpression: (P: any, L: any) => void;
    blink: () => void;
    look: (P: any) => void;
    setView: (P: any) => void;
    clearFace: () => void;
    restart: () => void;
    poke: (P: any, L: any) => void;
    gaze: (P: any) => void;
};
export { O2 as createAvatarEngine };
//# sourceMappingURL=avatar-core.d.ts.map