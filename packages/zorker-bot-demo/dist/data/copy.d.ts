import type { ScriptedScreen } from '../types';
export declare const DEMO_WIDTH = 976;
export declare const DEMO_HEIGHT = 660;
export declare const EMAIL = "armand@acme.co";
export declare const PASSWORD_LENGTH = 9;
export declare const USER_REQUEST = "Overnight pipeline generation and outbound.\n\nPick eligible prospects from this Google Sheet, research them on the web, grab context on contacts and accounts from Hex, Sumble, and Salesforce. Draft email and LinkedIn sequences in my voice.";
export declare const GREETING = "Hey Armand, good to meet you. What do you want me around for? Anything concrete, or more of a general sidekick?";
export declare const CHECKING_CONNECTIONS = "Checking what's connected. Hex, Gmail, and LinkedIn are already signed in. Salesforce isn't.";
export declare const COMPUTER_INSTRUCTION = "Sign in to Salesforce so I can see the accounts you own.";
export declare const COMPUTER_ASK = "Sign into Salesforce";
export declare const CONNECTED_SUMMARY = "\u2713 **Salesforce** \u2192 list pulled \u00B7 52 accounts\n\u2713 **Hex** \u2192 3 lookalike segments pulled\n\u2713 **LinkedIn** \u2192 4 profiles skipped \u00B7 recently contacted\n\u2713 **Sequencer** \u2192 36 drafts queued \u00B7 0 sent";
export declare const CONTEXT_MESSAGE = "@[Account Manager] sent over the Acme + Globex threads and @[Chief] flagged the priority accounts. Both are folded into tonight\u2019s list.";
export declare const DRAFTS_MESSAGE = "The 36 drafts are sitting in the LinkedIn queue on my screen: recipient, opener, and a Draft badge on each. Nothing goes out until you\u2019ve had a look.";
export declare const SEND_MESSAGE = "The top 10 look good. Send it. Run this every week.";
export declare const DONE_MESSAGE = "Done.";
export declare const ROUTINE: {
    name: string;
    triggerDescription: string;
};
export declare const INITIAL_SCREEN: ScriptedScreen;
export declare const END_SCREEN: ScriptedScreen;
//# sourceMappingURL=copy.d.ts.map