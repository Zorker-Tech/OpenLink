export const PROMPT_SUGGESTION_EXAMPLES = [
  'A requested bug fix is done but checks have not run: "run the tests".',
  'A code change is ready to inspect: "try it out".',
  'The user has been offered choices: name the option that fits their earlier preferences.',
  'The user was asked whether to continue: "yes" or "go ahead".',
  'The task is complete and one next action is obvious: "commit this".',
  "The work failed or missed the request: stay silent and let the user respond.",
] as const

export const PROMPT_SUGGESTION_EXCLUSIONS = [
  "Praise or thanks without an action.",
  "Status narration such as 'I am testing now'.",
  "Questions or requests for new direction.",
  "First-person assistant narration.",
  "Ideas that were not part of the request.",
  "Multiple sentences.",
  "Any suggestion while the user is in Debug mode.",
] as const
