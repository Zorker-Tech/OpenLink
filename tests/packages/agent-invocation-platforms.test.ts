import { test } from "node:test"
import assert from "node:assert/strict"

import { renderInteropInvocationPlatformContext, toSlateInvocationContext } from "../../source/adapters/interop/agent/invocation-platforms-adapter.ts"
import {
  InvocationContext,
  InvocationContext_GithubPR,
  InvocationContext_IdeState,
  InvocationContext_IdeState_File,
  InvocationContext_IdeState_ViewedPullRequest,
  InvocationContext_MicrosoftTeamsThread,
  InvocationContext_SlackThread,
} from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"

// ---------------------------------------------------------------------------------------------
// a message that came from a chat integration
// ---------------------------------------------------------------------------------------------

test("a pull-request wire record is projected before Slate renders its prompt section", () => {
  const invocation = new InvocationContext({
    data: {
      case: "githubPr",
      value: new InvocationContext_GithubPR({
        title: "Fix login",
        description: "Repair the session check",
        comments: "Please cover expired sessions",
        ciFailures: "unit suite failed",
      }),
    },
  })
  assert.deepEqual(toSlateInvocationContext(invocation), {
    kind: "pull_request",
    pullRequest: {
      title: "Fix login",
      description: "Repair the session check",
      reviewComments: "Please cover expired sessions",
      buildFailures: "unit suite failed",
    },
  })

  const text = renderInteropInvocationPlatformContext(invocation, false)?.text ?? ""
  assert.match(text, /^<pull_request_context>/)
  assert.match(text, /Pull request title: Fix login/)
  assert.match(text, /Description:\nRepair the session check/)
  assert.match(text, /Recent review comments:\nPlease cover expired sessions/)
  assert.match(text, /Build failures to consider:\nunit suite failed/)
  assert.match(text, /<\/pull_request_context>$/)
  assert.doesNotMatch(text, /github_pr_context|GitHub/)
})

const slackInvocation = (thread: InvocationContext_SlackThread): InvocationContext =>
  new InvocationContext({ data: { case: "slackThread", value: thread } })

test("a Slack thread is written out with its channel and the sender", () => {
  const rendered = renderInteropInvocationPlatformContext(slackInvocation(new InvocationContext_SlackThread({
    thread: "alice: the build is red",
    channelName: "eng-builds",
    channelPurpose: "Build failures",
    channelTopic: "keep it green",
    senderName: "Alice",
    senderId: "U123",
    senderType: "user",
  })), false)

  assert.equal(rendered?.type, "text")
  const text = rendered?.text ?? ""
  assert.match(text, /^<conversation_context>\n/)
  assert.match(text, /<conversation_channel>\nChannel: #eng-builds\n/)
  assert.match(text, /Channel purpose: Build failures\n/)
  assert.match(text, /Channel topic: keep it green\n/)
  assert.match(text, /<conversation_thread>\nThe user shared this conversation for additional context:\nalice: the build is red\n/)
  assert.match(text, /Sender: The current message is being sent by Alice \(U123\) \(user\)\n/)
  assert.match(text, /<\/conversation_context>$/)
})

test("a Slack thread with nothing but a thread says only that", () => {
  const rendered = renderInteropInvocationPlatformContext(slackInvocation(new InvocationContext_SlackThread({
    thread: "just the thread",
  })), false)
  const text = rendered?.text ?? ""
  assert.doesNotMatch(text, /<conversation_channel>/)
  assert.match(text, /<conversation_thread>/)
})

test("a Slack thread with no channel and no sender says nothing inside its context", () => {
  const rendered = renderInteropInvocationPlatformContext(slackInvocation(new InvocationContext_SlackThread({})), false)
  assert.equal(rendered?.text, "<conversation_context>\n</conversation_context>")
})

test("a sender with only an id is still named", () => {
  const rendered = renderInteropInvocationPlatformContext(slackInvocation(new InvocationContext_SlackThread({
    senderId: "U123",
  })), false)
  assert.match(rendered?.text ?? "", /Sender: The current message is being sent by U123\n/)
})

// ---------------------------------------------------------------------------------------------
// a message that came from a Teams channel
// ---------------------------------------------------------------------------------------------

const teamsInvocation = (thread: InvocationContext_MicrosoftTeamsThread): InvocationContext =>
  new InvocationContext({ data: { case: "microsoftTeamsThread", value: thread } })

test("a Teams thread is written out with its team and channel", () => {
  const rendered = renderInteropInvocationPlatformContext(teamsInvocation(new InvocationContext_MicrosoftTeamsThread({
    thread: "the thread body",
    teamName: "Platform",
    teamDescription: "Everything under the app",
    channelName: "releases",
    channelDescription: "Ship notes",
  })), false)

  const text = rendered?.text ?? ""
  assert.match(text, /^<conversation_context>\n/)
  assert.match(text, /<conversation_channel>\nWorkspace: Platform\nWorkspace details: Everything under the app\nChannel: #releases\nChannel details: Ship notes\n/)
  assert.match(text, /<conversation_thread>\nThe user shared this conversation for additional context:\nthe thread body\n<\/conversation_thread>\n/)
  assert.match(text, /<\/conversation_context>$/)
})

test("a Teams thread with no channel metadata and no thread says only that it is a Teams context", () => {
  const rendered = renderInteropInvocationPlatformContext(teamsInvocation(new InvocationContext_MicrosoftTeamsThread({})), false)
  assert.equal(rendered?.text, "<conversation_context>\n</conversation_context>")
})

test("a Teams channel with only a team name still gets its channel block", () => {
  const rendered = renderInteropInvocationPlatformContext(teamsInvocation(new InvocationContext_MicrosoftTeamsThread({
    teamName: "Platform",
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /<conversation_channel>\nWorkspace: Platform\n<\/conversation_channel>/)
  assert.doesNotMatch(text, /conversation_thread/)
})

// ---------------------------------------------------------------------------------------------
// a request started from the editor
// ---------------------------------------------------------------------------------------------

const ideInvocation = (state: InvocationContext_IdeState): InvocationContext =>
  new InvocationContext({ data: { case: "ideState", value: state } })

const file = (path: string, overrides: Partial<{ totalLines: number; activeCommand: string; cursorLine: number }> = {}): InvocationContext_IdeState_File =>
  new InvocationContext_IdeState_File({
    path,
    totalLines: overrides.totalLines ?? -1,
    ...(overrides.activeCommand === undefined ? {} : { activeCommand: overrides.activeCommand }),
    ...(overrides.cursorLine === undefined ? {} : { cursorPosition: { line: overrides.cursorLine, column: 0 } as never }),
  })

test("what the user has open is written out, with the focused file marked", () => {
  const rendered = renderInteropInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    visibleFiles: [file("/repo/a.ts", { totalLines: 120, cursorLine: 42 }), file("/repo/b.ts")],
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /^<workspace_editor_context>\n/)
  assert.match(text, /Workspace files currently open in the editor:\n/)
  assert.match(text, /- \/repo\/a\.ts \(focused file, cursor on line 42, 120 total lines\)\n/)
  assert.match(text, /- \/repo\/b\.ts\n/)
  assert.match(text, /These files may be unrelated to the current conversation\./)
})

test("the recently viewed files are listed oldest first", () => {
  const rendered = renderInteropInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    recentlyViewedFiles: [file("/repo/recent.ts"), file("/repo/older.ts")],
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /Recently viewed workspace files/)
  assert.match(text, /- \/repo\/older\.ts\n- \/repo\/recent\.ts\n/)
})

test("an editor with nothing open says so rather than listing nothing", () => {
  const rendered = renderInteropInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({})), false)
  const text = rendered?.text ?? ""
  assert.match(text, /No workspace files are open in the editor\.\n/)
  assert.doesNotMatch(text, /Recently viewed files/)
})

test("a file with no line count is listed without one", () => {
  const rendered = renderInteropInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    visibleFiles: [file("/repo/a.ts", { totalLines: -1, cursorLine: 7 })],
  })), false)
  assert.match(rendered?.text ?? "", /- \/repo\/a\.ts \(focused file, cursor on line 7\)\n/)
})

test("terminal files are left out unless the session works with them", () => {
  const terminalPath = "/repo/.slate/projects/workspace-1/terminals/3.txt"
  const state = new InvocationContext_IdeState({
    visibleFiles: [file("/repo/a.ts"), file(terminalPath, { activeCommand: "pnpm test" })],
    recentlyViewedFiles: [file(terminalPath, { activeCommand: "pnpm test" })],
  })

  const without = renderInteropInvocationPlatformContext(ideInvocation(state), false)
  assert.doesNotMatch(without?.text ?? "", /terminals\/3\.txt/)
  assert.doesNotMatch(without?.text ?? "", /active command/)

  const with_ = renderInteropInvocationPlatformContext(ideInvocation(state), true)
  assert.match(with_?.text ?? "", /- \/repo\/\.slate\/projects\/workspace-1\/terminals\/3\.txt \(active command: pnpm test\)\n/)
  assert.match(with_?.text ?? "", /Recently viewed workspace files/)
})

// ---------------------------------------------------------------------------------------------
// a pull request the user was reading
// ---------------------------------------------------------------------------------------------

const summaryJson = JSON.stringify({
  headRef: "feature/login",
  baseRef: "main",
  totalFiles: 2,
  totalDiffLines: 30,
  totalDiffSizeChars: 900,
  files: [
    { path: "src/app.ts", status: "modified", diffLines: 20, diffSizeChars: 600, originalSizeChars: 400 },
    { path: "src/new.ts", diffFileName: "renamed.diff", status: "added", diffLines: 10, diffSizeChars: 300 },
  ],
})

test("a pull request is summarised with its branch, its files and where its diff lives", () => {
  const rendered = renderInteropInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    currentlyViewedPrs: [new InvocationContext_IdeState_ViewedPullRequest({
      number: 42,
      title: "Add login",
      url: "https://example.test/pr/42",
      description: "A short description",
      folderPath: "/repo/.slate/prs/42",
      summaryJson,
    })],
  })), false)

  const text = rendered?.text ?? ""
  assert.match(text, /\nPull request currently being viewed:\n/)
  assert.match(text, /Pull request #42: Add login\n/)
  assert.match(text, /- Link: https:\/\/example\.test\/pr\/42\n/)
  assert.match(text, /- Branch: feature\/login → main\n/)
  assert.match(text, /- Description: A short description\n/)
  assert.match(text, /- Review files are available in \/repo\/\.slate\/prs\/42\n/)
  assert.match(text, /    - all\.diff: complete change set\n/)
  assert.match(text, /- Summary: 2 files, 30 lines, 900 characters\n/)
  assert.match(text, /  - src\/app\.ts \(diff: diffs\/src__app\.ts\.diff\)\n    modified, 20 changed lines, 600 characters, 400 original characters\n/)
  assert.match(text, /  - src\/new\.ts \(diff: diffs\/renamed\.diff\)\n    added, 10 changed lines, 300 characters\n/)
})

test("several pull requests are announced in the plural", () => {
  const rendered = renderInteropInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    currentlyViewedPrs: [
      new InvocationContext_IdeState_ViewedPullRequest({ number: 1, title: "one" }),
      new InvocationContext_IdeState_ViewedPullRequest({ number: 2, title: "two" }),
    ],
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /\nPull requests currently being viewed:\n/)
  assert.match(text, /Pull request #1: one\n/)
  assert.match(text, /Pull request #2: two\n/)
})

test("a long description is cut and says where the rest is", () => {
  const rendered = renderInteropInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    currentlyViewedPrs: [new InvocationContext_IdeState_ViewedPullRequest({
      number: 7,
      description: "x".repeat(600),
    })],
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /- Description: x{500}\.\.\. \(shortened; the complete text is in summary\.json\)\n/)
})

test("a pull request that carries no number is written out with the default one", () => {
  // The number is a plain field rather than an optional one, so a message that never set it reads as zero.
  const rendered = renderInteropInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    currentlyViewedPrs: [new InvocationContext_IdeState_ViewedPullRequest({ title: "no number" })],
  })), false)
  assert.match(rendered?.text ?? "", /Pull request currently being viewed:\nPull request #0: no number\n/)
})

test("a summary that does not parse is read from the file instead of being guessed at", () => {
  const rendered = renderInteropInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    currentlyViewedPrs: [new InvocationContext_IdeState_ViewedPullRequest({
      number: 9,
      folderPath: "/repo/.slate/prs/9",
      summaryJson: "{ not json",
    })],
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /- Read summary\.json for the file list and change sizes\.\n/)
  assert.doesNotMatch(text, /- Branch:/)
})

test("a pull request with no folder says only what it knows", () => {
  const rendered = renderInteropInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    currentlyViewedPrs: [new InvocationContext_IdeState_ViewedPullRequest({ number: 3, title: "small" })],
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /Pull request #3: small\n/)
  assert.doesNotMatch(text, /Contents:/)
  assert.doesNotMatch(text, /Files changed:/)
})

// ---------------------------------------------------------------------------------------------
// anything else
// ---------------------------------------------------------------------------------------------

test("an invocation from nowhere in particular has no platform context", () => {
  assert.equal(renderInteropInvocationPlatformContext(new InvocationContext({}), false), undefined)
})
