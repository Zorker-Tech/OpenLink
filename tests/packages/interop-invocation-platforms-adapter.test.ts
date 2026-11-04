import { test } from "node:test"
import assert from "node:assert/strict"

import {
  InvocationContext,
  InvocationContext_IdeState,
  InvocationContext_IdeState_File,
  InvocationContext_IdeState_ViewedPullRequest,
  InvocationContext_MicrosoftTeamsThread,
  InvocationContext_SlackThread,
} from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { toSlateInvocationContext } from "../../source/adapters/interop/agent/invocation-platforms-adapter.ts"

test("the chat-thread schema becomes a Slate conversation and sender", () => {
  const invocation = new InvocationContext({
    data: {
      case: "slackThread",
      value: new InvocationContext_SlackThread({
        channelName: "builds",
        channelPurpose: "Build health",
        thread: "the build is red",
        senderName: "Ada",
        senderId: "U1",
        senderType: "user",
      }),
    },
  })

  const result = toSlateInvocationContext(invocation)
  assert.equal(result.kind, "conversation")
  if (result.kind !== "conversation") return
  assert.equal(result.conversation.channel?.channelName, "builds")
  assert.equal(result.conversation.channel?.purpose, "Build health")
  assert.equal(result.conversation.body, "the build is red")
  assert.deepEqual(result.conversation.sender, { name: "Ada", id: "U1", kind: "user" })
})

test("the team-and-channel fields share Slate's workspace channel shape", () => {
  const invocation = new InvocationContext({
    data: {
      case: "microsoftTeamsThread",
      value: new InvocationContext_MicrosoftTeamsThread({
        teamName: "Platform",
        teamDescription: "Product work",
        channelName: "releases",
        channelDescription: "Ship notes",
      }),
    },
  })

  const result = toSlateInvocationContext(invocation)
  assert.equal(result.kind, "conversation")
  if (result.kind !== "conversation") return
  assert.equal(result.conversation.channel?.workspaceName, "Platform")
  assert.equal(result.conversation.channel?.workspaceDescription, "Product work")
  assert.equal(result.conversation.channel?.channelName, "releases")
  assert.equal(result.conversation.channel?.channelDescription, "Ship notes")
})

test("the editor snapshot and viewed pull requests become Slate editor context", () => {
  const invocation = new InvocationContext({
    data: {
      case: "ideState",
      value: new InvocationContext_IdeState({
        visibleFiles: [new InvocationContext_IdeState_File({
          path: "/repo/app.ts",
          totalLines: 90,
          cursorPosition: { line: 12 },
        })],
        currentlyViewedPrs: [new InvocationContext_IdeState_ViewedPullRequest({
          number: 7,
          title: "Improve startup",
          folderPath: "/repo/.slate/reviews/7",
        })],
      }),
    },
  })

  const result = toSlateInvocationContext(invocation)
  assert.equal(result.kind, "editor")
  if (result.kind !== "editor") return
  assert.deepEqual(result.editor.visibleFiles[0], {
    path: "/repo/app.ts",
    totalLines: 90,
    activeCommand: undefined,
    cursorLine: 12,
  })
  assert.equal(result.editor.currentlyViewedPullRequests?.[0]?.number, 7)
  assert.equal(result.editor.currentlyViewedPullRequests?.[0]?.title, "Improve startup")
})

test("invocation variants outside this adapter return the Slate unsupported case", () => {
  assert.deepEqual(toSlateInvocationContext(new InvocationContext({})), { kind: "unsupported" })
})
