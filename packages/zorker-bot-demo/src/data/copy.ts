import type { ScriptedScreen } from '../types'

export const DEMO_WIDTH = 976
export const DEMO_HEIGHT = 660

export const EMAIL = 'armand@acme.co'
export const PASSWORD_LENGTH = 9

export const USER_REQUEST =
  'Overnight pipeline generation and outbound.\n\nPick eligible prospects from this Google Sheet, research them on the web, grab context on contacts and accounts from Hex, Sumble, and Salesforce. Draft email and LinkedIn sequences in my voice.'

export const GREETING =
  'Hey Armand, good to meet you. What do you want me around for? Anything concrete, or more of a general sidekick?'

export const CHECKING_CONNECTIONS =
  "Checking what's connected. Hex, Gmail, and LinkedIn are already signed in. Salesforce isn't."

export const COMPUTER_INSTRUCTION = 'Sign in to Salesforce so I can see the accounts you own.'
export const COMPUTER_ASK = 'Sign into Salesforce'

export const CONNECTED_SUMMARY =
  '✓ **Salesforce** → list pulled · 52 accounts\n✓ **Hex** → 3 lookalike segments pulled\n✓ **LinkedIn** → 4 profiles skipped · recently contacted\n✓ **Sequencer** → 36 drafts queued · 0 sent'

export const CONTEXT_MESSAGE =
  '@[Account Manager] sent over the Acme + Globex threads and @[Chief] flagged the priority accounts. Both are folded into tonight’s list.'

export const DRAFTS_MESSAGE =
  'The 36 drafts are sitting in the LinkedIn queue on my screen: recipient, opener, and a Draft badge on each. Nothing goes out until you’ve had a look.'

export const SEND_MESSAGE = 'The top 10 look good. Send it. Run this every week.'
export const DONE_MESSAGE = 'Done.'

export const ROUTINE = {
  name: 'Overnight outbound',
  triggerDescription: 'Sundays at 11:00 PM',
}

export const INITIAL_SCREEN: ScriptedScreen = {
  view: 'login',
  emailChars: 0,
  passwordChars: 0,
  focus: null,
  isWorking: false,
}

export const END_SCREEN: ScriptedScreen = {
  view: 'portal',
  emailChars: EMAIL.length,
  passwordChars: PASSWORD_LENGTH,
  focus: null,
  isWorking: false,
}
