import type { useDemoSequence } from '../hooks/useDemoSequence';
export type ZorkerBotWindowProps = {
    demo: ReturnType<typeof useDemoSequence>;
    rootSize: {
        width: number;
        height: number;
    };
    assetBase: string;
};
export declare function ZorkerBotWindow({ demo, rootSize, assetBase }: ZorkerBotWindowProps): import("react").JSX.Element;
//# sourceMappingURL=ZorkerBotWindow.d.ts.map