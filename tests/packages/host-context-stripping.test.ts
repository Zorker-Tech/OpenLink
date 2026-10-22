import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as stripping from "../../source/host/transcript/agent-transcript/context-stripping.ts";
import { CONTEXT_TAGS_TO_STRIP, stripContextTags, stripTags } from "../../source/host/transcript/agent-transcript/context-stripping.ts";

describe("what a transcript leaves out", () => {
  it("names the context tags it strips, in the order the platform declares them", () => {
    assert.deepEqual([...CONTEXT_TAGS_TO_STRIP], [
      "user_info", "project_layout", "rules", "always_applied_workspace_rules", "agent_requestable_workspace_rules", "user_rules", "agent_skills", "available_skills",
      "cloud_instructions", "cloud_task_instructions", "open_and_recently_viewed_files", "system_reminder", "system-reminder", "mcp_instructions", "mcp_file_system",
      "mcp_file_system_servers", "git_status", "agent_transcripts", "cursor_rules_context", "attached_files", "system_notification", "task_notification", "agent_notification",
    ]);
    assert.deepEqual(Object.keys(stripping).sort(), ["CONTEXT_TAGS_TO_STRIP", "stripContextTags", "stripTags"]);
  });

  it("takes a context block out and keeps the words around it", () => {
    assert.equal(stripContextTags("<user_info>private profile</user_info>"), "");
    assert.equal(stripContextTags("hello\n\n<user_info>profile</user_info>\n\nbye"), "hello\n\nbye");
    assert.equal(stripContextTags("before <rules>a rule</rules> after"), "before  after");
    // Attributes are part of the element, and so is content across lines.
    assert.equal(stripContextTags('<user_info attr="x">with attributes</user_info>'), "");
    assert.equal(stripContextTags("<user_info>line one\nline two</user_info>kept"), "kept");
  });

  it("takes every block of a tag, and compares the tag without case", () => {
    assert.equal(stripContextTags("<user_info>a</user_info>middle<user_info>b</user_info>"), "middle", "the walk is one block at a time, not one match across both");
    assert.equal(stripContextTags("<USER_INFO>upper case</USER_INFO>"), "");
    assert.equal(stripContextTags("<User_Info>mixed case</User_Info>"), "");
    assert.equal(stripContextTags("<user_info>unclosed"), "<user_info>unclosed", "an unclosed block is not a block");
    assert.equal(stripContextTags("<user_infos>look-alike</user_infos>"), "<user_infos>look-alike</user_infos>");
    assert.equal(stripContextTags("<other_tag>kept</other_tag>"), "<other_tag>kept</other_tag>");
  });

  it("collapses the blank lines a block leaves behind, and trims the text", () => {
    assert.equal(stripContextTags("one\n\n\ntwo"), "one\n\ntwo");
    assert.equal(stripContextTags("one\n\n\n\n\ntwo"), "one\n\ntwo");
    assert.equal(stripContextTags("one\n\ntwo"), "one\n\ntwo", "two newlines are a paragraph break, not a gap");
    assert.equal(stripContextTags("  padded text  "), "padded text");
    assert.equal(stripContextTags("\n\n\nleading"), "leading");
    // A block in the middle of a gap leaves the gap collapsed behind it.
    assert.equal(stripContextTags("a\n\n\n\n<user_info>x</user_info>\n\n\n\nb"), "a\n\nb");
  });

  it("strips a nested block whole, and keeps text that only looks like a tag", () => {
    assert.equal(stripContextTags("<rules>outer<user_info>inner</user_info>outer</rules>"), "", "the outer block takes the inner one with it");
    assert.equal(stripContextTags("text with <angle> brackets"), "text with <angle> brackets");
    assert.equal(stripContextTags("代理 <user_info>プロフィール</user_info> 完了"), "代理  完了");
  });

  it("lets a caller name the tags, which are read as patterns rather than as literals", () => {
    assert.equal(stripTags("<user_info>a</user_info><other_tag>b</other_tag>", ["user_info"]), "<other_tag>b</other_tag>");
    assert.equal(stripTags("<a.b>dot</a.b><axb>not dot</axb>", ["a.b"]), "", "the tag is a pattern: the dot also matches the x");
    assert.equal(stripTags("no tags here", ["user_info"]), "no tags here");
    assert.equal(stripTags("<user_info>a</user_info>", []), "<user_info>a</user_info>");
  });
});