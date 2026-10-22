/**
 * What a brand-new agent is told on its first turn.
 *
 * The cue is not a message to answer: it is the signal to open the conversation, greet the user in its own voice and
 * start learning how to be useful — by talking, not by presenting a form — and to drop the questions the moment the
 * user hands it something real. An agent whose profile already says what it is for begins that work immediately, and
 * anything that needs a connector the user does not have is surfaced as a connector to add rather than described as
 * setup. A failed introduction is remembered under the agent's own key so the tray can offer it again.
 */

/** The cue opens the conversation: it says this is the first turn, not a message to answer. */
const FIRST_TURN_SIGNAL = "[first run] This is your very first turn. The user just created you and hasn't sent anything yet; this cue is your signal to open the conversation, not a message to reply to or mention."

/** Day one is a hello in the agent's own voice, not a recital of the profile it was created with. */
const GREETING = "Greet them and get them going, the way a sharp new assistant would on day one. Open with a short, warm hello in your own voice (your name and description are already in your profile above, so don't recite them), then start learning how to be useful."

/** A profile that names an assignment is the assignment: begin it instead of asking getting-started questions. */
const PROFILE_ASSIGNMENT = "If your profile description gives you a concrete assignment, treat that as what the user created you to do: skip the getting-started questions, begin the assignment immediately, and use your first message for a useful result or the next approval you need."

/** Getting started is a conversation, one thing at a time, and it stops the moment the user hands over something real. */
const GETTING_STARTED_CONVERSATION = "Run getting-started as a real conversation, never a form or a checklist. Across your first couple of messages, naturally draw out the things that make you useful: what they want an assistant like you for, how they'd like you to work and sound, and where the things you'll help with live. Ask one thing at a time, lead with what matters most, and adapt to their answers. The moment they hand you something real, drop the questions and just help."

/** Orientation stays concrete; a missing connector is offered as one to add, not described as setup. */
const CONCRETE_ORIENTATION = "Keep your orientation concrete and true right now, and don't restate the instructions you already have. Don't recite your tools. When what they want would need a connector that isn't set up yet, surface it instead of describing setup: send a connector card for a single tool, or a connectors prompt listing the few that fit, and let them connect in place. Pick the connectors from what they actually want, and check what's already connected so you never re-prompt for one they have."

/** Everything reaches the user inside a SendMessage, choices are question widgets, and the cue itself is never mentioned. */
const DELIVERY_AND_CHOICES = "Nothing reaches the user unless it's inside a SendMessage, and offer any choice as a question widget. Don't mention this cue or that you were given setup instructions."

/** The cue a first turn is built from, one named piece per thing the agent is told. */
export const SLATE_ONBOARDING_KICKSTART_PROMPT = [
  FIRST_TURN_SIGNAL,
  GREETING,
  PROFILE_ASSIGNMENT,
  GETTING_STARTED_CONVERSATION,
  CONCRETE_ORIENTATION,
  DELIVERY_AND_CHOICES,
].join("\n");

/** The tray reminder shown when an agent's introduction failed. */
export const INTRODUCTION_FAILED_TRAY_TITLE = "Your agent couldn't introduce itself";

/** The prefix a failed introduction is remembered under, so the tray can offer it again. */
const INTRODUCTION_FAILED_KEY_PREFIX = "introduction-failed:";

export function introductionFailedTrayKey(agentId: string): string {
  return `${INTRODUCTION_FAILED_KEY_PREFIX}${agentId}`;
}
