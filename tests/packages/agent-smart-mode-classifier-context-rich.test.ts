import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  tryExtractSlateAutoReviewClassifierConversationContext,
  tryExtractSmartModeClassifierConversationContext,
} from "../../source/packages/agent/smart-mode-classifier-context.ts";
import { ConversationStateHandle } from "../../source/packages/agent/state.ts";
import { createContext, type Context } from "../../source/packages/context/context.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";
import { toRedactedConversationStateStructure } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/agent_redacted.ts";
import { toRedactedCoreMessage } from "../../source/packages/redaction/message-redaction.ts";
import {
  AgentConversationTurnStructure,
  AssistantMessage,
  ConversationStateStructure,
  ConversationStep,
  ConversationTurnStructure,
  SimulatedMsgReason,
  ToolCall,
  UserMessage,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import {
  AskQuestionArgs,
  AskQuestionArgs_Option,
  AskQuestionArgs_Question,
  AskQuestionResult,
  AskQuestionSuccess,
  AskQuestionSuccess_Answer,
  AskQuestionToolCall,
} from "../../source/adapters/interop/proto/generated/agent/v1/ask_question_tool_pb.ts";
import {
  ClickAction,
  ComputerUseAction,
  ComputerUseResult,
  ComputerUseSuccess,
  ComputerUseToolCall,
  Coordinate,
  MouseButton,
} from "../../source/adapters/interop/proto/generated/agent/v1/computer_use_tool_pb.ts";
import { SelectedContext, SelectedCursorCommand } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts";
import { AgentSkill } from "../../source/adapters/interop/proto/generated/agent/v1/agent_skills_pb.ts";
import { ProtobufBlobSerde } from "../../source/adapters/interop/agent/protobuf-blob-serde-adapter.ts";
import { getBlobId } from "../../source/packages/agent-kv/blob-store.ts";

const stepSerde = new ProtobufBlobSerde(ConversationStep);
const turnSerde = new ProtobufBlobSerde(ConversationTurnStructure);
const userMessageSerde = new ProtobufBlobSerde(UserMessage);

interface TurnSpec {
  userText?: string;
  userMessage?: UserMessage;
  assistantMessages?: readonly string[];
  conversationSteps?: readonly ConversationStep[];
  notAnAgentTurn?: boolean;
}

/** A conversation built from the same blob serdes the agent uses, so the classifier walks real handles. */
async function conversation(options: { turns: readonly TurnSpec[]; rootPromptTexts?: readonly string[] }) {
  const ctx: Context = createContext();
  const blobs = new Map<string, Uint8Array>();
  const keyOf = (id: Uint8Array): string => Buffer.from(id).toString("hex");
  const blobStore = {
    async getBlob(_ctx: Context, blobId: Uint8Array) { return blobs.get(keyOf(blobId)) },
    async setBlob(_ctx: Context, blobId: Uint8Array, data: Uint8Array) { blobs.set(keyOf(blobId), data) },
    async setBlobLocallyOnly(_ctx: Context, blobId: Uint8Array, data: Uint8Array) { blobs.set(keyOf(blobId), data) },
    async flush() {},
  };
  const store = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const blobId = await getBlobId(bytes);
    blobs.set(keyOf(blobId), bytes);
    return blobId;
  };
  const handle = new ConversationStateHandle(
    blobStore as never,
    toRedactedConversationStateStructure(new ConversationStateStructure({}), PrivacyMode.NO_STORAGE),
    { appendMessages() {}, getState: () => [], clearMessages() {} } as never,
    {},
    "composer-2",
  );
  const turnHandles: unknown[] = [];
  for (const turnSpec of options.turns) {
    if (turnSpec.notAnAgentTurn === true) {
      turnHandles.push({ get: async () => ({ not: "a turn" }) });
      continue;
    }
    const steps: Uint8Array[] = [];
    for (const text of turnSpec.assistantMessages ?? []) {
      steps.push(await store(stepSerde.serialize(new ConversationStep({
        message: { case: "assistantMessage", value: new AssistantMessage({ text }) },
      }))));
    }
    for (const step of turnSpec.conversationSteps ?? []) {
      steps.push(await store(stepSerde.serialize(step)));
    }
    const userMessage = turnSpec.userMessage ?? new UserMessage({ text: turnSpec.userText ?? "", messageId: "message-" + turnHandles.length });
    const userMessageBlobId = new Uint8Array(await store(userMessageSerde.serialize(userMessage)));
    const turnBytes = turnSerde.serialize(new ConversationTurnStructure({
      turn: {
        case: "agentConversationTurn",
        value: new AgentConversationTurnStructure({ userMessage: userMessageBlobId, steps, sendMessageStepIndices: [] }),
      },
    }));
    await store(turnBytes);
    turnHandles.push(handle.createConversationTurnHandleSerde().deserialize(turnBytes));
  }
  const rootPromptMessages = (options.rootPromptTexts ?? []).map(text => toRedactedCoreMessage({ role: "user", content: text } as never, PrivacyMode.NO_STORAGE));
  return {
    ctx,
    stateHandler: {
      turns: turnHandles.map(turnHandle => ({ get: async () => turnHandle })),
      rootPromptBuilder: { appendMessages() {}, clearMessages() {}, getState: () => rootPromptMessages },
    },
  };
}

const sliceOf = (messages: readonly unknown[]): Array<{ role: string; content: string }> =>
  messages.map(message => ({ role: String((message as { role: string }).role), content: String((message as { content: string }).content) }));

async function editorSlice(options: Parameters<typeof conversation>[0]) {
  const { ctx, stateHandler } = await conversation(options);
  return sliceOf(await tryExtractSmartModeClassifierConversationContext(ctx, stateHandler as never));
}
async function autoSlice(options: Parameters<typeof conversation>[0], extractOptions?: Record<string, unknown>) {
  const { ctx, stateHandler } = await conversation(options);
  return sliceOf(await tryExtractSlateAutoReviewClassifierConversationContext(ctx, stateHandler as never, extractOptions as never));
}

/** A message long enough to be interesting. */
const longMessage = (length: number): string => "x".repeat(length);
const MARKER = "\n...[auto-review context truncated]...\n";

describe("the classifier context beyond the basic slice", () => {
  it("takes the newest messages of each kind, with more of the conversation for auto-review", async () => {
    const fiveAnswers = { turns: [{ userText: "go", assistantMessages: ["a1", "a2", "a3", "a4", "a5"] }] };
    assert.deepEqual((await editorSlice(fiveAnswers)).map(message => message.content), ["a4", "a5", "go"]);
    assert.deepEqual((await autoSlice(fiveAnswers)).map(message => message.content), ["a2", "a3", "a4", "a5", "go"]);
    const threeUsers = { turns: [{ userText: "first" }, { userText: "second" }, { userText: "third" }] };
    assert.deepEqual((await editorSlice(threeUsers)).map(message => message.content), ["second", "third"]);
    assert.deepEqual((await autoSlice(threeUsers)).map(message => message.content), ["second", "third"]);
  });

  it("skips a turn that is not an agent turn, and empty answers", async () => {
    const slice = await editorSlice({
      turns: [{ userText: "first", assistantMessages: ["a1"] }, { notAnAgentTurn: true }, { userText: "third", assistantMessages: ["", "  ", "a3"] }],
    });
    assert.deepEqual(slice.map(message => [message.role, message.content]), [["assistant", "a1"], ["assistant", "a3"], ["user", "first"], ["user", "third"]]);
  });

  it("reads answered questions from the Slate step operation with labels and freeform text", async () => {
    const questionStep = new ConversationStep({
      message: {
        case: "toolCall",
        value: new ToolCall({
          tool: {
            case: "askQuestionToolCall",
            value: new AskQuestionToolCall({
              args: new AskQuestionArgs({
                title: "Choose a direction",
                questions: [new AskQuestionArgs_Question({
                  id: "q-1",
                  prompt: "Which path?",
                  options: [new AskQuestionArgs_Option({ id: "left", label: "Left" })],
                })],
                runAsync: true,
                asyncOriginalToolCallId: "call-1",
              }),
              result: new AskQuestionResult({
                result: {
                  case: "success",
                  value: new AskQuestionSuccess({ answers: [new AskQuestionSuccess_Answer({
                    questionId: "q-1",
                    selectedOptionIds: ["left", "unknown-option"],
                    freeformText: "check the adjacent file",
                  })] }),
                },
              }),
            }),
          },
        }),
      },
    })
    const slice = await autoSlice({
      turns: [{ userText: "review this choice", conversationSteps: [questionStep] }],
    })

    assert.ok(slice.some(message =>
      message.role === "user_answer" &&
      message.content === "Q: Which path?\nA: Left, unknown-option, check the adjacent file",
    ))
  })

  it("builds computer-use classifier context from the Slate operation and keeps screenshots out of the prompt", async () => {
    const computerStep = new ConversationStep({
      message: {
        case: "toolCall",
        value: new ToolCall({
          toolCallId: "outer-call",
          tool: {
            case: "computerUseToolCall",
            value: new ComputerUseToolCall({
              args: {
                toolCallId: "inner-call",
                description: "inspect the menu",
                actions: [new ComputerUseAction({
                  action: {
                    case: "click",
                    value: new ClickAction({
                      coordinate: new Coordinate({ x: 12, y: 5 }),
                      button: MouseButton.LEFT,
                      count: 2,
                      modifierKeys: "CTRL",
                    }),
                  },
                })],
              },
              result: new ComputerUseResult({
                result: {
                  case: "success",
                  value: new ComputerUseSuccess({
                    actionCount: 1,
                    durationMs: 18,
                    screenshot: "private image bytes",
                    log: "clicked",
                    screenshotPath: "/tmp/capture.png",
                    cursorPosition: new Coordinate({ x: 12, y: 5 }),
                  }),
                },
              }),
            }),
          },
        }),
      },
    })
    const { ctx, stateHandler } = await conversation({
      turns: [{ userText: "inspect the page", conversationSteps: [computerStep] }],
    })

    const messages = await tryExtractSlateAutoReviewClassifierConversationContext(ctx, stateHandler as never)
    assert.deepEqual(messages.at(-1), {
      role: "computer",
      content: `request:\n{"purpose":"inspect the menu","actions":[{"kind":"click","coordinate":{"x":12,"y":5},"button":"left","count":2,"modifierKeys":"CTRL"}]}\nresult:\n{"status":"success","actionCount":1,"durationMs":18,"log":"clicked","screenshotPath":"/tmp/capture.png","cursorPosition":{"x":12,"y":5},"screenshotOmitted":true}`,
    })
    assert.doesNotMatch(messages.at(-1)!.content, /private image bytes/)
  })

  it("skips a message the platform wrote, and trusts the ones it is told to trust", async () => {
    const options = { excludedUserMessageTextPrefixes: ["[wake]"], trustedUserMessageTextPrefixes: ["[trusted]"] };
    const skipped = await autoSlice({ turns: [{ userText: "[wake] automatic wake" }, { userText: "real request" }] }, options);
    assert.deepEqual(skipped.map(message => message.content), ["real request"]);
    const trusted = await autoSlice({ turns: [{ userText: "[wake] automatic wake" }, { userText: "[trusted] trusted request" }] }, options);
    assert.deepEqual(trusted.map(message => message.content), ["trusted request"], "the trusted prefix itself is not part of the message");
    const both = await autoSlice({ turns: [{ userText: "[trusted][wake] both" }] }, options);
    assert.deepEqual(both.map(message => message.content), ["[wake] both"]);
  });

  it("does not read a completion notice or a goal continuation as the user's intent", async () => {
    for (const reason of [SimulatedMsgReason.BACKGROUND_TASK_COMPLETION, SimulatedMsgReason.GOAL_CONTINUATION]) {
      const slice = await editorSlice({
        turns: [{ userMessage: new UserMessage({ text: "the platform spoke", messageId: "m", isSimulatedMsg: true, simulatedMsgReason: reason }) }],
      });
      assert.deepEqual(slice, [], String(reason));
    }
    const plan = await editorSlice({
      turns: [{ userMessage: new UserMessage({ text: "plan step", messageId: "m", isSimulatedMsg: true, simulatedMsgReason: SimulatedMsgReason.PLAN_EXECUTION }) }],
    });
    assert.equal(plan.length, 1, "a simulated message the user is meant to see is rendered");
    assert.ok(plan[0]!.content.length > 0);
  });

  it("names the files a turn invoked in front of its message, for the newest turn only", async () => {
    const selectedContext = new SelectedContext({
      cursorCommands: [new SelectedCursorCommand({ name: "deploy", fullPath: "/commands/deploy.md" })],
      selectedSkills: [new AgentSkill({ fullPath: "/skills/review/SKILL.md", content: "review" })],
    });
    const slice = await editorSlice({
      turns: [{
        userText: "old request",
      }, {
        userMessage: new UserMessage({ text: "new request", messageId: "m", selectedContext }),
      }],
    });
    const newest = slice.at(-1)!;
    assert.equal(newest.role, "user");
    assert.equal(newest.content.startsWith('<invoked_skills note="skill files the user explicitly invoked for this request">\n- /skills/review/SKILL.md\n</invoked_skills>'), true);
    assert.match(newest.content, /<invoked_commands note="command files the user explicitly invoked for this request">\n- \/commands\/deploy\.md\n<\/invoked_commands>/);
    assert.equal(newest.content.endsWith("\n\nnew request"), true);
    assert.deepEqual(slice.slice(0, -1).map(message => message.content), ["old request"], "an older turn is not annotated");
  });

  it("never annotates an older turn, even when it has invoked files of its own", async () => {
    const oldContext = new SelectedContext({ cursorCommands: [new SelectedCursorCommand({ name: "old", fullPath: "/commands/old.md" })] });
    const slice = await editorSlice({
      turns: [
        { userMessage: new UserMessage({ text: "old request", messageId: "old", selectedContext: oldContext }) },
        { userText: "new request" },
      ],
      rootPromptTexts: ["<manually_attached_skills>\nPath: /skills/current/SKILL.md\n</manually_attached_skills>"],
    });
    assert.deepEqual(slice.map(message => message.content), [
      "old request",
      '<invoked_skills note="skill files the user explicitly invoked for this request">\n- /skills/current/SKILL.md\n</invoked_skills>\n\nnew request',
    ], "the older turn keeps its plain text while the newest one is annotated");
  });

  it("adds the skill paths the current turn attached in its root prompt", async () => {
    const slice = await editorSlice({
      turns: [{ userText: "request" }],
      rootPromptTexts: ["<manually_attached_skills>\nPath: /skills/one/SKILL.md\nPath: /skills/two/SKILL.md\n</manually_attached_skills>"],
    });
    assert.equal(slice.length, 1);
    assert.equal(slice[0]!.content.startsWith('<invoked_skills note="skill files the user explicitly invoked for this request">\n- /skills/one/SKILL.md\n- /skills/two/SKILL.md\n</invoked_skills>\n\nrequest'), true);
    const late = await editorSlice({ turns: [{ userText: "request" }], rootPromptTexts: ["</manually_attached_skills>\nPath: /skills/late/SKILL.md"] });
    assert.deepEqual(late.map(message => message.content), ["request"], "a path after the close tag is not attached");
  });

  it("cuts an auto-review message around its marker, and leaves a short one alone", async () => {
    const exact = await autoSlice({ turns: [{ userText: "go", assistantMessages: [longMessage(4_000)] }] });
    assert.equal(exact[0]!.content.length, 4_000);
    assert.equal(exact[0]!.content.includes(MARKER), false);
    const cut = await autoSlice({ turns: [{ userText: "go", assistantMessages: [longMessage(4_001)] }] });
    assert.equal(cut[0]!.content.includes(MARKER), true);
    const textBudget = 4_000 - MARKER.length;
    const headChars = Math.ceil(textBudget / 2);
    assert.equal(cut[0]!.content.startsWith(longMessage(headChars)), true);
    assert.equal(cut[0]!.content.endsWith(longMessage(textBudget - headChars)), true);
  });

  it("bounds the editor slice as a whole, shrinking a tier before cutting messages", async () => {
    const slice = await editorSlice({
      turns: [{ userText: longMessage(3_000), assistantMessages: [longMessage(4_000), longMessage(4_000), longMessage(4_000)] }],
    });
    assert.equal(slice.length, 2);
    assert.deepEqual(slice.map(message => message.role), ["assistant", "user"]);
    assert.equal(slice.reduce((sum, message) => sum + message.content.length, 0) <= 8_000, true);
    // When no tier can shrink any further, the budget is filled in a fixed order and messages are cut.
    const filled = await editorSlice({ turns: [{ userText: longMessage(4_500), assistantMessages: [longMessage(5_000)] }] });
    assert.deepEqual(filled.map(message => [message.role, message.content.length]), [["assistant", 3_500], ["user", 4_500]], "the budget fills user messages first, then cuts the assistant message");
  });
});
