export const manualHandoffDescription = `Give the user control of the box for one manual step, then finish this turn. The user completes the step themselves and returns control; the agent resumes and should inspect the current screen before continuing. Never ask for passwords or one-time codes: the user enters those on the box. For a direct sign-in, set domain to the destination app. If sign-in redirects to an identity provider, keep the destination app in domain and set idp_domain to the identity provider host.`

export function existingHandoffInstruction(instruction: string): string {
  return `The previous handoff for "${instruction}" is still in progress, so no new request was sent. Do not try again. If the user's step has changed, tell them what changed with SendMessage; otherwise wait for this handoff to return control.`
}

export const handoffStartedReply = "The user now controls the box. Wait for them to return control; the agent resumes automatically. Inspect the current screen before continuing."
