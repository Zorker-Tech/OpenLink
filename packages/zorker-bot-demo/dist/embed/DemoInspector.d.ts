import { type OpenLinkDemoScenario } from './scenarios';
export type DemoStep = 'ready' | 'running' | 'action' | 'control' | 'done';
export type Schedule = 'Every Monday' | 'Every Friday';
type DemoInspectorProps = {
    scenario: OpenLinkDemoScenario;
    step: DemoStep;
    schedule: Schedule;
    approved: boolean | null;
    open: boolean;
    onClose: () => void;
    onTakeOver: () => void;
    onResume: () => void;
};
export declare function DemoInspector({ scenario, step, schedule, approved, open, onClose, onTakeOver, onResume }: DemoInspectorProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=DemoInspector.d.ts.map