import { displaySpaceSentence } from "../../boxes/box-monitor-layout.ts";

export const COMPUTER_USE_SUBAGENT_TYPE = "computerUse";

function normalizedType(value: string): string {
  return value.replace(/[-_ ]/g, "").toLowerCase();
}

export function isComputerUseSubagentType(value: string | null | undefined): boolean {
  return value != null && normalizedType(value) === normalizedType(COMPUTER_USE_SUBAGENT_TYPE);
}

function taskGuidance(browserUseOffered: boolean): string[] {
  if (!browserUseOffered) {
    return [
      "Use this agent for tasks that need the box desktop, such as installed apps, file dialogs, or navigating sites.",
    ];
  }

  return [
    "Use desktop controls for GUI apps, file dialogs, drag-and-drop, and sites page automation cannot complete. Work from screenshots with click, drag, type, key, scroll, and wait actions.",
    "For tasks contained in a webpage, prefer browserUse. Choose computerUse when the task needs operating-system controls or browserUse reports a limitation.",
  ];
}

function operatingGuidance(): string[] {
  return [
    "This runs as a background task; wait for its completion notice instead of polling it.",
    "It cannot ask follow-up questions. Provide one bounded task, the needed site or app details, non-secret values, success checks, and a stopping condition. Use MessageSubagent to redirect it or StopSubagent to end a stuck run.",
    "Dispatch only one computerUse task at a time because these tasks share one desktop.",
    "If a step requires a person to enter credentials, complete 2FA or a captcha, or approve a payment, stop and report that step. Use request_box_help for user takeover, then dispatch a follow-up task.",
  ];
}

export function computerUseSubagentDescription(browserUseOffered: boolean): string {
  return [
    ...taskGuidance(browserUseOffered),
    displaySpaceSentence(),
    ...operatingGuidance(),
  ].join(" ");
}

export function createSlateComputerUseSubagentConfig(args: {
  readonly browserUseOffered: boolean
}) {
  return {
    subagent_type: {
      type: {
        case: "custom",
        value: { name: COMPUTER_USE_SUBAGENT_TYPE },
      },
    },
    description: computerUseSubagentDescription(args.browserUseOffered),
    preserveTaskTool: false,
    subagentSource: "builtin" as const,
  }
}
