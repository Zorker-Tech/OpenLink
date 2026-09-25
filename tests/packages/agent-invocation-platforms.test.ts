import { test } from "node:test"
import assert from "node:assert/strict"

import { renderInvocationPlatformContext } from "../../source/packages/agent/context/invocation-platforms.ts"
import {
  InvocationContext,
  InvocationContext_IdeState,
  InvocationContext_IdeState_File,
  InvocationContext_IdeState_ViewedPullRequest,
  InvocationContext_MicrosoftTeamsThread,
  InvocationContext_SlackThread,
} from "../../source/packages/proto/generated/agent/v1/selected_context_pb.ts"

// ---------------------------------------------------------------------------------------------
// a message that came from a chat integration
// ---------------------------------------------------------------------------------------------

const slackInvocation = (thread: InvocationContext_SlackThread): InvocationContext =>
  new InvocationContext({ data: { case: "slackThread", value: thread } })

test("a Slack thread is written out with its channel and the sender", () => {
  const rendered = renderInvocationPlatformContext(slackInvocation(new InvocationContext_SlackThread({
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
  assert.match(text, /^<slack_context>\n/)
  assert.match(text, /<slack_channel>\nChannel: #eng-builds\n/)
  assert.match(text, /Channel purpose: Build failures\n/)
  assert.match(text, /Channel topic: keep it green\n/)
  assert.match(text, /<slack_thread>\nThe user shared the following Slack thread for additional context\nalice: the build is red\n/)
  assert.match(text, /The current message is being sent by Alice \(U123\) \(user\)\n/)
  assert.match(text, /<\/slack_context>$/)
})

test("a Slack thread with nothing but a thread says only that", () => {
  const rendered = renderInvocationPlatformContext(slackInvocation(new InvocationContext_SlackThread({
    thread: "just the thread",
  })), false)
  const text = rendered?.text ?? ""
  assert.doesNotMatch(text, /<slack_channel>/)
  assert.match(text, /<slack_thread>/)
})

test("a Slack thread with no channel and no sender says nothing inside its context", () => {
  const rendered = renderInvocationPlatformContext(slackInvocation(new InvocationContext_SlackThread({})), false)
  assert.equal(rendered?.text, "<slack_context>\n</slack_context>")
})

test("a sender with only an id is still named", () => {
  const rendered = renderInvocationPlatformContext(slackInvocation(new InvocationContext_SlackThread({
    senderId: "U123",
  })), false)
  assert.match(rendered?.text ?? "", /The current message is being sent by U123\n/)
})

// ---------------------------------------------------------------------------------------------
// a message that came from a Teams channel
// ---------------------------------------------------------------------------------------------

const teamsInvocation = (thread: InvocationContext_MicrosoftTeamsThread): InvocationContext =>
  new InvocationContext({ data: { case: "microsoftTeamsThread", value: thread } })

test("a Teams thread is written out with its team and channel", () => {
  const rendered = renderInvocationPlatformContext(teamsInvocation(new InvocationContext_MicrosoftTeamsThread({
    thread: "the thread body",
    teamName: "Platform",
    teamDescription: "Everything under the app",
    channelName: "releases",
    channelDescription: "Ship notes",
  })), false)

  const text = rendered?.text ?? ""
  assert.match(text, /^<microsoft_teams_context>\n/)
  assert.match(text, /<microsoft_teams_channel>\nTeam: Platform\nTeam description: Everything under the app\nChannel: #releases\nChannel description: Ship notes\n/)
  assert.match(text, /<microsoft_teams_thread>\nThe user shared the following Microsoft Teams thread for additional context\nthe thread body\n<\/microsoft_teams_thread>\n/)
  assert.match(text, /<\/microsoft_teams_context>$/)
})

test("a Teams thread with no channel metadata and no thread says only that it is a Teams context", () => {
  const rendered = renderInvocationPlatformContext(teamsInvocation(new InvocationContext_MicrosoftTeamsThread({})), false)
  assert.equal(rendered?.text, "<microsoft_teams_context>\n</microsoft_teams_context>")
})

test("a Teams channel with only a team name still gets its channel block", () => {
  const rendered = renderInvocationPlatformContext(teamsInvocation(new InvocationContext_MicrosoftTeamsThread({
    teamName: "Platform",
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /<microsoft_teams_channel>\nTeam: Platform\n<\/microsoft_teams_channel>/)
  assert.doesNotMatch(text, /microsoft_teams_thread/)
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
  const rendered = renderInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    visibleFiles: [file("/repo/a.ts", { totalLines: 120, cursorLine: 42 }), file("/repo/b.ts")],
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /^<open_and_recently_viewed_files>\n/)
  assert.match(text, /Files that are currently open and visible in the user's IDE:\n/)
  assert.match(text, /- \/repo\/a\.ts \(currently focused file, cursor is on line 42, total lines: 120\)\n/)
  assert.match(text, /- \/repo\/b\.ts\n/)
  assert.match(text, /Note: these files may or may not be relevant to the current conversation\./)
})

test("the recently viewed files are listed oldest first", () => {
  const rendered = renderInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    recentlyViewedFiles: [file("/repo/recent.ts"), file("/repo/older.ts")],
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /Recently viewed files \(recent at the top, oldest at the bottom\):\n/)
  assert.match(text, /- \/repo\/older\.ts\n- \/repo\/recent\.ts\n/)
})

test("an editor with nothing open says so rather than listing nothing", () => {
  const rendered = renderInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({})), false)
  const text = rendered?.text ?? ""
  assert.match(text, /User currently doesn't have any open files in their IDE\.\n/)
  assert.doesNotMatch(text, /Recently viewed files/)
})

test("a file with no line count is listed without one", () => {
  const rendered = renderInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    visibleFiles: [file("/repo/a.ts", { totalLines: -1, cursorLine: 7 })],
  })), false)
  assert.match(rendered?.text ?? "", /- \/repo\/a\.ts \(currently focused file, cursor is on line 7\)\n/)
})

test("terminal files are left out unless the session works with them", () => {
  const terminalPath = "/repo/.slate/projects/workspace-1/terminals/3.txt"
  const state = new InvocationContext_IdeState({
    visibleFiles: [file("/repo/a.ts"), file(terminalPath, { activeCommand: "pnpm test" })],
    recentlyViewedFiles: [file(terminalPath, { activeCommand: "pnpm test" })],
  })

  const without = renderInvocationPlatformContext(ideInvocation(state), false)
  assert.doesNotMatch(without?.text ?? "", /terminals\/3\.txt/)
  assert.doesNotMatch(without?.text ?? "", /active command/)

  const with_ = renderInvocationPlatformContext(ideInvocation(state), true)
  assert.match(with_?.text ?? "", /- \/repo\/\.slate\/projects\/workspace-1\/terminals\/3\.txt \(active command: pnpm test\)\n/)
  assert.match(with_?.text ?? "", /Recently viewed files/)
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
  const rendered = renderInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
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
  assert.match(text, /\nCurrently viewing Pull Request:\n/)
  assert.match(text, /PR #42: Add login\n/)
  assert.match(text, /- URL: https:\/\/example\.test\/pr\/42\n/)
  assert.match(text, /- Branch: feature\/login → main\n/)
  assert.match(text, /- Description: A short description\n/)
  assert.match(text, /- Some additional details about the PR are available in the folder \/repo\/\.slate\/prs\/42\n/)
  assert.match(text, /    - all\.diff: Complete diff of all files in one file\n/)
  assert.match(text, /- Summary: 2 files, 30 lines, 900 chars\n/)
  assert.match(text, /  - src\/app\.ts \(diff: diffs\/src__app\.ts\.diff\)\n    modified, 20 diff lines, 600 diff chars, 400 original chars\n/)
  assert.match(text, /  - src\/new\.ts \(diff: diffs\/renamed\.diff\)\n    added, 10 diff lines, 300 diff chars\n/)
})

test("several pull requests are announced in the plural", () => {
  const rendered = renderInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    currentlyViewedPrs: [
      new InvocationContext_IdeState_ViewedPullRequest({ number: 1, title: "one" }),
      new InvocationContext_IdeState_ViewedPullRequest({ number: 2, title: "two" }),
    ],
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /\nCurrently viewing Pull Requests:\n/)
  assert.match(text, /PR #1: one\n/)
  assert.match(text, /PR #2: two\n/)
})

test("a long description is cut and says where the rest is", () => {
  const rendered = renderInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    currentlyViewedPrs: [new InvocationContext_IdeState_ViewedPullRequest({
      number: 7,
      description: "x".repeat(600),
    })],
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /- Description: x{500}\.\.\. \(truncated, full description in summary\.json\)\n/)
})

test("a pull request that carries no number is written out with the default one", () => {
  // The number is a plain field rather than an optional one, so a message that never set it reads as zero.
  const rendered = renderInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    currentlyViewedPrs: [new InvocationContext_IdeState_ViewedPullRequest({ title: "no number" })],
  })), false)
  assert.match(rendered?.text ?? "", /Currently viewing Pull Request:\nPR #0: no number\n/)
})

test("a summary that does not parse is read from the file instead of being guessed at", () => {
  const rendered = renderInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    currentlyViewedPrs: [new InvocationContext_IdeState_ViewedPullRequest({
      number: 9,
      folderPath: "/repo/.slate/prs/9",
      summaryJson: "{ not json",
    })],
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /- Read summary\.json for file list and diff sizes\.\n/)
  assert.doesNotMatch(text, /- Branch:/)
})

test("a pull request with no folder says only what it knows", () => {
  const rendered = renderInvocationPlatformContext(ideInvocation(new InvocationContext_IdeState({
    currentlyViewedPrs: [new InvocationContext_IdeState_ViewedPullRequest({ number: 3, title: "small" })],
  })), false)
  const text = rendered?.text ?? ""
  assert.match(text, /PR #3: small\n/)
  assert.doesNotMatch(text, /Contents:/)
  assert.doesNotMatch(text, /Files changed:/)
})

// ---------------------------------------------------------------------------------------------
// anything else
// ---------------------------------------------------------------------------------------------

test("an invocation from nowhere in particular has no platform context", () => {
  assert.equal(renderInvocationPlatformContext(new InvocationContext({}), false), undefined)
})
