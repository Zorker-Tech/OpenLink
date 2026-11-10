/**
 * The slice of a conversation a classifier is shown before it judges a call.
 *
 * A classifier decides whether a tool call may run, so what it sees has to be enough to judge the call in context —
 * the last thing the user asked for, what the agent answered, what the user replied when asked a question, and the
 * paths of the skills or commands the turn invoked — and no more. Two kinds of limits do that work: a small number of
 * the most recent messages of each kind, read newest first, and a character budget applied per message and again across
 * the whole slice, with a marker left where content was cut so a truncated message reads as truncated.
 *
 * Two sessions use this with different limits. The editor's classifier is shown a couple of messages with a larger
 * budget; the auto-review classifier, which judges on its own, sees more of the conversation with a smaller per-message
 * budget, and is also given the current turn's computer-use calls because those are what it most often judges.
 *
 * What is excluded matters as much as what is included: a message the platform wrote rather than the user (a wake-up,
 * a completion notice, an automated continuation) is not read as the user's intent unless its text is known trusted,
 * and an answer the platform produced is not counted as the user's. The extraction is best-effort: a conversation that
 * cannot be read yields no context rather than failing the call the classifier was asked to judge.
 */
import { AgentConversationTurnHandle, type ConversationStateHandle } from "./state.ts"
import type {
  SlateAskQuestionToolCall,
  SlateComputerUseAction,
  SlateComputerUseToolCall,
  SlateConversationStep,
  SlateToolCallText,
} from "./conversation-step-state.ts"
import {
  isAutomaticClassifierContextMessageInterop,
  readClassifierUserMessageInterop,
  selectedWorkflowPathsForClassifierInterop,
  toSmartModeClassifierConversationMessagesInterop,
} from "../../adapters/interop/agent/smart-mode-classifier-context-adapter.ts"
import { fromRedactedCoreMessage } from "../redaction/message-redaction.ts"
import { PrivacyCapability } from "../redaction/classification.ts"
import { isRedactedString } from "../redaction/redacted-values.ts"
import type { SlateAskQuestionText } from "./actions/ask-question-completion.ts"
import type { Context as OperationContext } from "../context/context.ts"

export interface SlateClassifierConversationMessage {
  readonly role: string
  readonly content: string
}

/** How many of each kind the editor's classifier sees, and how big its whole slice may be. */
const EDITOR_CONTEXT_LIMITS = {
  maxAssistantMessages: 2,
  maxUserMessages: 2,
  maxQuestionResults: 2,
  maxQuestionSteps: 50,
}
const EDITOR_CONTEXT_MAX_CHARS = 8e3

/** How much of the conversation the auto-review classifier sees, and how much of each message. */
const AUTO_REVIEW_CONTEXT_LIMITS = {
  maxAssistantMessages: 4,
  maxUserMessages: 2,
  maxQuestionResults: 2,
  maxQuestionSteps: EDITOR_CONTEXT_LIMITS.maxQuestionSteps,
}
const AUTO_REVIEW_MESSAGE_MAX_CHARS = 4e3
const AUTO_REVIEW_TRUNCATION_MARKER = "\n...[auto-review context truncated]...\n"

type ClassifierStateHandler = Pick<ConversationStateHandle, "turns" | "rootPromptBuilder">
/** One line of the slice, before it becomes the classifier protocol's message shape. */
type ClassifierLine = { role: string; content: string }

/** The text of one assistant step, when the step is an assistant message with something in it. */
function assistantTextOf(step: SlateConversationStep): string | undefined {
  if (step.kind !== "assistant-message") return undefined
  const text = step.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).trim()
  return text.length > 0 ? text : undefined
}

/** The newest assistant texts, oldest first. */
async function recentAssistantTexts(ctx: OperationContext, stateHandler: ClassifierStateHandler, maxMessages: number): Promise<string[]> {
  const newestFirst: string[] = []
  for (let turnIndex = stateHandler.turns.length - 1; turnIndex >= 0 && newestFirst.length < maxMessages; turnIndex--) {
    const turn = await stateHandler.turns[turnIndex]!.get(ctx)
    if (!(turn instanceof AgentConversationTurnHandle)) continue
    const steps = (turn as any).steps
    const stepCount = turn.stepCount
    for (let stepIndex = stepCount - 1; stepIndex >= 0 && newestFirst.length < maxMessages; stepIndex--) {
      const text = assistantTextOf(await steps[stepIndex].get(ctx) as SlateConversationStep)
      if (text !== undefined) newestFirst.push(text)
    }
  }
  return newestFirst.toReversed()
}

function classifierText(value: SlateToolCallText): string {
  return isRedactedString(value) ? value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : value
}

/** Renders a Slate computer action as a JSON-safe, product-owned classifier value. */
function computerActionForClassifier(action: SlateComputerUseAction): Record<string, unknown> {
  switch (action.kind) {
    case "mouse-move":
      return { kind: action.kind, ...(action.coordinate === undefined ? {} : { coordinate: action.coordinate }) }
    case "click":
      return {
        kind: action.kind,
        ...(action.coordinate === undefined ? {} : { coordinate: action.coordinate }),
        button: action.button,
        count: action.count,
        ...(action.modifierKeys === undefined ? {} : { modifierKeys: classifierText(action.modifierKeys) }),
      }
    case "mouse-down":
    case "mouse-up":
      return { kind: action.kind, button: action.button }
    case "drag":
      return {
        kind: action.kind,
        path: action.path,
        button: action.button,
        ...(action.modifierKeys === undefined ? {} : { modifierKeys: classifierText(action.modifierKeys) }),
      }
    case "scroll":
      return {
        kind: action.kind,
        ...(action.coordinate === undefined ? {} : { coordinate: action.coordinate }),
        direction: action.direction,
        amount: action.amount,
        ...(action.modifierKeys === undefined ? {} : { modifierKeys: classifierText(action.modifierKeys) }),
      }
    case "type":
      return { kind: action.kind, text: classifierText(action.text) }
    case "key":
      return {
        kind: action.kind,
        key: classifierText(action.key),
        ...(action.holdDurationMs === undefined ? {} : { holdDurationMs: action.holdDurationMs }),
      }
    case "wait":
      return { kind: action.kind, durationMs: action.durationMs }
    case "screenshot":
      return { kind: action.kind }
    case "cursor-position":
      return { kind: action.kind }
    case "missing":
      return { kind: action.kind }
    case "unsupported":
      return { kind: action.kind, sourceCase: action.sourceCase, ...(action.payload === undefined ? {} : { payload: action.payload }) }
  }
}

/** What one computer-use call looks like to a classifier: the call it makes and the outcome it had. */
function computerCallContext(toolCall: SlateComputerUseToolCall): string {
  const declaredPurpose = toolCall.args?.description === undefined
    ? undefined
    : classifierText(toolCall.args.description).trim()
  const input = {
    ...(declaredPurpose !== undefined && declaredPurpose.length > 0 ? { purpose: declaredPurpose } : {}),
    actions: toolCall.args?.actions.map(computerActionForClassifier) ?? [],
  }
  const result = toolCall.result
  const output = result?.kind === "success"
    ? {
        status: "success",
        actionCount: result.actionCount,
        durationMs: result.durationMs,
        ...(result.log === undefined ? {} : { log: classifierText(result.log) }),
        ...(result.screenshotPath === undefined ? {} : { screenshotPath: classifierText(result.screenshotPath) }),
        ...(result.cursorPosition === undefined ? {} : { cursorPosition: result.cursorPosition }),
        screenshotOmitted: result.screenshot !== undefined && classifierText(result.screenshot).length > 0,
      }
    : result?.kind === "error"
      ? {
          status: "error",
          error: classifierText(result.message),
          actionCount: result.actionCount,
          durationMs: result.durationMs,
          ...(result.log === undefined ? {} : { log: classifierText(result.log) }),
          ...(result.screenshotPath === undefined ? {} : { screenshotPath: classifierText(result.screenshotPath) }),
          screenshotOmitted: result.screenshot !== undefined && classifierText(result.screenshot).length > 0,
        }
      : { status: "pending" }
  return `request:\n${JSON.stringify(input)}\nresult:\n${JSON.stringify(output)}`
}

/** The index of the turn that carries the user's current intent: the newest turn with a user message to read. */
async function intentTurnIndex(ctx: OperationContext, stateHandler: ClassifierStateHandler, excludedPrefixes: readonly string[], trustedPrefixes: readonly string[]): Promise<number> {
  let index = stateHandler.turns.length - 1
  for (let turnIndex = stateHandler.turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = await stateHandler.turns[turnIndex]!.get(ctx)
    if (!(turn instanceof AgentConversationTurnHandle)) continue
    const userMessage = await (turn as any).userMessage.get(ctx) as any
    const text = userMessageContextText(userMessage, {
      includeInvokedWorkflowFilesAnnotation: false,
      currentTurnInvokedSkillPaths: [],
      excludedUserMessageTextPrefixes: excludedPrefixes,
      trustedUserMessageTextPrefixes: trustedPrefixes,
    })
    if (text !== undefined) {
      index = turnIndex
      break
    }
  }
  return index
}

/** The computer-use calls from the turn that carries the user's current intent onward. */
async function intentComputerCalls(ctx: OperationContext, stateHandler: ClassifierStateHandler, excludedPrefixes: readonly string[], trustedPrefixes: readonly string[]): Promise<string[]> {
  if (stateHandler.turns.length === 0) return []
  const firstIntentTurn = await intentTurnIndex(ctx, stateHandler, excludedPrefixes, trustedPrefixes)
  const computerCalls: string[] = []
  for (let turnIndex = firstIntentTurn; turnIndex < stateHandler.turns.length; turnIndex++) {
    const turn = await stateHandler.turns[turnIndex]!.get(ctx)
    if (!(turn instanceof AgentConversationTurnHandle)) continue
    for (const stepRef of (turn as any).steps) {
      const step = await stepRef.get(ctx) as SlateConversationStep
      if (step.kind !== "tool-call" || step.tool.kind !== "computer-use") continue
      computerCalls.push(computerCallContext(step.tool))
    }
  }
  return computerCalls
}

/** A path with surrounding whitespace removed, or nothing when there is no path in it. */
function pathInside(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const INVOKED_SKILLS_OPEN_TAG = '<invoked_skills note="skill files the user explicitly invoked for this request">'
const INVOKED_SKILLS_CLOSE_TAG = "</invoked_skills>"
const INVOKED_COMMANDS_OPEN_TAG = '<invoked_commands note="command files the user explicitly invoked for this request">'
const INVOKED_COMMANDS_CLOSE_TAG = "</invoked_commands>"
const MANUALLY_ATTACHED_SKILLS_CLOSE_TAG = "</manually_attached_skills>"
const MANUALLY_ATTACHED_PATH_PREFIX = "Path:"

/** The paths named in the skill blocks a message carries as text. */
function manuallyAttachedPaths(text: string): string[] {
  const blocks = text.match(/<manually_attached_skills>[\s\S]*?<\/manually_attached_skills>/g) ?? []
  const paths = new Set<string>()
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      const trimmedLine = line.trim()
      if (!trimmedLine.startsWith(MANUALLY_ATTACHED_PATH_PREFIX)) continue
      const fullPath = pathInside(trimmedLine.slice(MANUALLY_ATTACHED_PATH_PREFIX.length))
      if (fullPath !== undefined) paths.add(fullPath)
    }
  }
  return [...paths]
}

/** One core message's text parts. */
function coreMessageTexts(message: any): string[] {
  if (typeof message.content === "string") return [message.content]
  if (!Array.isArray(message.content)) return []
  return message.content.flatMap((part: any) => part.type === "text" ? [part.text] : [])
}

/** The skill paths the current turn invoked, read from its root prompt's last manually-attached section. */
function currentTurnSkillPaths(stateHandler: ClassifierStateHandler): string[] {
  const paths = new Set<string>()
  const rootPromptMessages = stateHandler.rootPromptBuilder.getState()
  for (let index = rootPromptMessages.length - 1; index >= 0; index--) {
    const message = fromRedactedCoreMessage(rootPromptMessages[index] as any, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    if (message.role !== "user") continue
    for (const text of coreMessageTexts(message)) {
      for (const path of manuallyAttachedPaths(text)) paths.add(path)
      if (text.includes(MANUALLY_ATTACHED_SKILLS_CLOSE_TAG)) return [...paths]
    }
    return [...paths]
  }
  return []
}

/** One annotation block: its tag pair around the paths as bullet lines. */
function annotationBlock(openTag: string, closeTag: string, paths: readonly string[]): string {
  return [openTag, ...paths.map(path => `- ${path}`), closeTag].join("\n")
}

/** A message's text with the paths of the workflow files it invoked in front of it. */
function withWorkflowAnnotations(baseText: string | undefined, paths: { skillPaths: readonly string[]; commandPaths: readonly string[] }): string {
  const annotations: string[] = []
  if (paths.skillPaths.length > 0) annotations.push(annotationBlock(INVOKED_SKILLS_OPEN_TAG, INVOKED_SKILLS_CLOSE_TAG, paths.skillPaths))
  if (paths.commandPaths.length > 0) annotations.push(annotationBlock(INVOKED_COMMANDS_OPEN_TAG, INVOKED_COMMANDS_CLOSE_TAG, paths.commandPaths))
  const annotation = annotations.join("\n\n")
  return baseText !== undefined && baseText.length > 0 ? `${annotation}\n\n${baseText}` : annotation
}

/** A user message read as classifier context, or undefined when the platform rather than the user wrote it. */
function userMessageContextText(userMessage: any, options: {
  includeInvokedWorkflowFilesAnnotation: boolean
  currentTurnInvokedSkillPaths: readonly string[]
  excludedUserMessageTextPrefixes: readonly string[]
  trustedUserMessageTextPrefixes: readonly string[]
}): string | undefined {
  const plainMessage = readClassifierUserMessageInterop(userMessage, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  const trustedPrefix = options.trustedUserMessageTextPrefixes.find(prefix => plainMessage.text.startsWith(prefix))
  const untrusted = options.excludedUserMessageTextPrefixes.some(prefix => plainMessage.text.startsWith(prefix))
  if (trustedPrefix === undefined && untrusted) return undefined
  if (isAutomaticClassifierContextMessageInterop(plainMessage.simulatedMsgReason)) return undefined
  const rawText = plainMessage.text.slice(trustedPrefix?.length ?? 0).trim()
  let baseText = rawText.length > 0 ? rawText : undefined
  if (plainMessage.isSimulatedMsg === true) {
    const simulatedText = (plainMessage.selectedContext?.simulatedMessagePrompts ?? [])
      .map(prompt => prompt.text.trim())
      .filter(text => text.length > 0)
      .join("\n\n")
      .trim()
    if (simulatedText.length > 0) baseText = simulatedText
  }
  if (!options.includeInvokedWorkflowFilesAnnotation) return baseText
  const selectedPaths = selectedWorkflowPathsForClassifierInterop(plainMessage.selectedContext)
  const skillPaths = [...new Set([
    ...selectedPaths.skillPaths.map(pathInside).filter((path): path is string => path !== undefined),
    ...options.currentTurnInvokedSkillPaths,
  ])]
  const commandPaths = [...new Set(selectedPaths.commandPaths.map(pathInside).filter((path): path is string => path !== undefined))]
  if (skillPaths.length === 0 && commandPaths.length === 0) return baseText
  return withWorkflowAnnotations(baseText, { skillPaths, commandPaths })
}

/** The newest user texts, oldest first, with only the newest turn annotated with the files it invoked. */
async function recentUserTexts(ctx: OperationContext, stateHandler: ClassifierStateHandler, maxMessages: number, excludedPrefixes: readonly string[], trustedPrefixes: readonly string[]): Promise<string[]> {
  const newestFirst: string[] = []
  let isMostRecentAgentTurn = true
  const turnSkillPaths = currentTurnSkillPaths(stateHandler)
  for (let turnIndex = stateHandler.turns.length - 1; turnIndex >= 0 && newestFirst.length < maxMessages; turnIndex--) {
    const turn = await stateHandler.turns[turnIndex]!.get(ctx)
    if (!(turn instanceof AgentConversationTurnHandle)) continue
    const userMessage = await (turn as any).userMessage.get(ctx) as any
    const text = userMessageContextText(userMessage, {
      includeInvokedWorkflowFilesAnnotation: isMostRecentAgentTurn,
      currentTurnInvokedSkillPaths: isMostRecentAgentTurn ? turnSkillPaths : [],
      excludedUserMessageTextPrefixes: excludedPrefixes,
      trustedUserMessageTextPrefixes: trustedPrefixes,
    })
    isMostRecentAgentTurn = false
    if (text !== undefined) newestFirst.push(text)
  }
  return newestFirst.toReversed()
}

/** One ask-question step's answer as classifier context, or undefined when it has no usable answer. */
function askQuestionAnswer(tool: SlateAskQuestionToolCall): string | undefined {
  const result = tool.result
  if (result?.kind !== "answered") return undefined
  const questionsById = new Map((tool.args?.questions ?? []).map(question => [question.id, question]))
  const plainText = (value: SlateAskQuestionText): string => isRedactedString(value)
    ? value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    : value
  const renderedAnswers: string[] = []
  for (const answer of result.answers) {
    const question = questionsById.get(answer.questionId)
    const optionLabelsById = new Map((question?.options ?? []).map(option => [option.id, plainText(option.label)]))
    const answerParts = answer.selectedOptionIds.map(optionId => optionLabelsById.get(optionId) ?? optionId)
    const freeformText = plainText(answer.freeformText).trim()
    if (freeformText !== undefined && freeformText.length > 0) answerParts.push(freeformText)
    if (answerParts.length === 0) continue
    const prompt = question === undefined ? undefined : plainText(question.prompt).trim()
    const answerText = answerParts.join(", ")
    renderedAnswers.push(prompt !== undefined && prompt.length > 0 ? `Q: ${prompt}\nA: ${answerText}` : `A: ${answerText}`)
  }
  return renderedAnswers.length > 0 ? renderedAnswers.join("\n\n") : undefined
}

/** The answers the user gave in the current turn, oldest first. */
async function recentAskAnswers(ctx: OperationContext, stateHandler: ClassifierStateHandler, maxResults: number, maxSteps: number): Promise<string[]> {
  const currentTurnRef = stateHandler.turns.at(-1)
  if (!currentTurnRef) return []
  const currentTurn = await currentTurnRef.get(ctx)
  if (!(currentTurn instanceof AgentConversationTurnHandle)) return []
  const newestFirst: string[] = []
  let stepsScanned = 0
  const steps = (currentTurn as any).steps
  for (let stepIndex = steps.length - 1; stepIndex >= 0 && stepsScanned < maxSteps && newestFirst.length < maxResults; stepIndex--) {
    stepsScanned++
    const step = await steps[stepIndex].get(ctx) as SlateConversationStep
    const askQuestion = step.kind === "tool-call" && step.tool.kind === "ask-question" ? step.tool : undefined
    if (askQuestion === undefined) continue
    const rendered = askQuestionAnswer(askQuestion)
    if (rendered !== undefined) newestFirst.push(rendered)
  }
  return newestFirst.toReversed()
}

/** Cut one auto-review message to its budget, leaving a marker where the middle was removed. */
function cutClassifierMessage(content: string, maxChars = AUTO_REVIEW_MESSAGE_MAX_CHARS): string {
  if (content.length <= maxChars) return content
  const textBudget = maxChars - AUTO_REVIEW_TRUNCATION_MARKER.length
  if (textBudget <= 0) return content.slice(0, maxChars)
  const headChars = Math.ceil(textBudget / 2)
  return `${content.slice(0, headChars)}${AUTO_REVIEW_TRUNCATION_MARKER}${content.slice(-(textBudget - headChars))}`
}

/** The newest messages of each counted role, as the sets a slice is built from. */
function newestByRole(lines: readonly ClassifierLine[], limits: { maxAssistantMessages: number; maxUserMessages: number; maxQuestionResults: number }) {
  return {
    assistants: new Set(lines.filter(line => line.role === "assistant").slice(-limits.maxAssistantMessages)),
    users: new Set(lines.filter(line => line.role === "user").slice(-limits.maxUserMessages)),
    answers: new Set(lines.filter(line => line.role === "user_answer").slice(-limits.maxQuestionResults)),
  }
}

/** Count-limited messages, in the order they were given; computer lines are never counted. */
function applyMessageCountLimits(lines: ClassifierLine[], limits: { maxAssistantMessages: number; maxUserMessages: number; maxQuestionResults: number }): ClassifierLine[] {
  const newest = newestByRole(lines, limits)
  return lines.filter(line => {
    if (line.role === "assistant") return newest.assistants.has(line)
    if (line.role === "user_answer") return newest.answers.has(line)
    if (line.role === "computer") return true
    return newest.users.has(line)
  })
}

/** The auto-review slice: count limits, then each message cut to its own budget, with empty lines dropped. */
function autoReviewLines(lines: ClassifierLine[], options: { limits?: typeof AUTO_REVIEW_CONTEXT_LIMITS; maxCharsPerMessage?: number } = {}): ClassifierLine[] {
  const limits = options.limits ?? AUTO_REVIEW_CONTEXT_LIMITS
  const maxCharsPerMessage = options.maxCharsPerMessage ?? AUTO_REVIEW_MESSAGE_MAX_CHARS
  return applyMessageCountLimits(lines, limits)
    .map(line => ({ ...line, content: cutClassifierMessage(line.content, maxCharsPerMessage) }))
    .filter(line => line.content.length > 0)
}

/** The editor slice: count limits, then a whole-slice budget that shrinks tier by tier before cutting individual messages. */
function shrinkEditorLines(lines: ClassifierLine[], options: { maxChars: number; maxAssistantMessages: number; maxUserMessages: number; maxQuestionMessages: number } = { maxChars: EDITOR_CONTEXT_MAX_CHARS, maxAssistantMessages: 2, maxUserMessages: 2, maxQuestionMessages: 2 }): ClassifierLine[] {
  let assistantLines = lines.filter(line => line.role === "assistant").slice(-options.maxAssistantMessages)
  let userLines = lines.filter(line => line.role === "user").slice(-options.maxUserMessages)
  let questionLines = lines.filter(line => line.role === "user_answer").slice(-(options.maxQuestionMessages ?? 2))
  let computerLines = lines.filter(line => line.role === "computer")
  const contentOverrides = new Map<ClassifierLine, string>()
  const buildLines = (): ClassifierLine[] => {
    const assistantKept = new Set(assistantLines)
    const userKept = new Set(userLines)
    const questionKept = new Set(questionLines)
    const computerKept = new Set(computerLines)
    return lines.flatMap(line => {
      const kept = line.role === "assistant" ? assistantKept.has(line)
        : line.role === "user_answer" ? questionKept.has(line)
          : line.role === "computer" ? computerKept.has(line)
            : userKept.has(line)
      return kept ? [{ ...line, content: contentOverrides.get(line) ?? line.content }] : []
    })
  }
  let result = buildLines()
  const totalChars = (items: ClassifierLine[]): number => items.reduce((sum, line) => sum + line.content.length, 0)
  while (totalChars(result) > options.maxChars && assistantLines.length > 1) { assistantLines = assistantLines.slice(1); result = buildLines() }
  while (totalChars(result) > options.maxChars && computerLines.length > 1) { computerLines = computerLines.slice(1); result = buildLines() }
  while (totalChars(result) > options.maxChars && questionLines.length > 1) { questionLines = questionLines.slice(1); result = buildLines() }
  while (totalChars(result) > options.maxChars && userLines.length > 1) { userLines = userLines.slice(1); result = buildLines() }
  if (totalChars(result) > options.maxChars) {
    let remaining = options.maxChars
    for (const line of [...userLines, ...questionLines, ...computerLines, ...assistantLines]) {
      if (remaining <= 0) { contentOverrides.set(line, ""); continue }
      const content = line.content.length <= remaining ? line.content : line.content.slice(0, remaining)
      remaining -= content.length
      contentOverrides.set(line, content)
    }
    result = buildLines()
  }
  return result.filter(line => line.content.length > 0)
}

/** The conversation slice shared by both classifiers: the newest of each kind, then the caller's truncation. */
async function conversationContext(
  ctx: OperationContext,
  stateHandler: ClassifierStateHandler,
  limits = EDITOR_CONTEXT_LIMITS,
  truncateLines = (lines: ClassifierLine[]) => shrinkEditorLines(lines),
  options?: { excludedUserMessageTextPrefixes?: readonly string[]; trustedUserMessageTextPrefixes?: readonly string[]; includeComputerToolCalls?: boolean },
): Promise<SlateClassifierConversationMessage[]> {
  const excludedPrefixes = options?.excludedUserMessageTextPrefixes ?? []
  const trustedPrefixes = options?.trustedUserMessageTextPrefixes ?? []
  const [assistantTexts, userTexts, questionAnswers, computerCalls] = await Promise.all([
    recentAssistantTexts(ctx, stateHandler, limits.maxAssistantMessages),
    recentUserTexts(ctx, stateHandler, limits.maxUserMessages, excludedPrefixes, trustedPrefixes),
    recentAskAnswers(ctx, stateHandler, limits.maxQuestionResults, limits.maxQuestionSteps),
    options?.includeComputerToolCalls === true ? intentComputerCalls(ctx, stateHandler, excludedPrefixes, trustedPrefixes) : [],
  ])
  const lines: ClassifierLine[] = [
    ...assistantTexts.map(content => ({ role: "assistant", content })),
    ...userTexts.map(content => ({ role: "user", content })),
    ...questionAnswers.map(content => ({ role: "user_answer", content })),
    ...computerCalls.map(content => ({ role: "computer", content })),
  ]
  return truncateLines(lines)
}

/** The auto-review classifier's slice: more of the conversation, a smaller per-message budget, and computer calls. */
async function autoReviewConversationContext(ctx: OperationContext, stateHandler: ClassifierStateHandler, options: { excludedUserMessageTextPrefixes?: readonly string[]; trustedUserMessageTextPrefixes?: readonly string[] } = {}): Promise<SlateClassifierConversationMessage[]> {
  return conversationContext(ctx, stateHandler, AUTO_REVIEW_CONTEXT_LIMITS, autoReviewLines, { ...options, includeComputerToolCalls: true })
}

/** The editor classifier's slice, or nothing when the conversation cannot be read. */
export async function tryExtractSmartModeClassifierConversationContext(ctx: OperationContext, stateHandler: ClassifierStateHandler): Promise<SlateClassifierConversationMessage[]> {
  try {
    const messages = await conversationContext(ctx, stateHandler)
    return toSmartModeClassifierConversationMessagesInterop(messages)
  } catch {
    return []
  }
}

/** The auto-review classifier's slice, or nothing when the conversation cannot be read. */
export async function tryExtractSlateAutoReviewClassifierConversationContext(ctx: OperationContext, stateHandler: ClassifierStateHandler, options?: { excludedUserMessageTextPrefixes?: readonly string[]; trustedUserMessageTextPrefixes?: readonly string[] }): Promise<SlateClassifierConversationMessage[]> {
  try {
    return await autoReviewConversationContext(ctx, stateHandler, options)
  } catch {
    return []
  }
}
