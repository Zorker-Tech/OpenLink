import { test } from "node:test"
import assert from "node:assert/strict"

import { Assistant, builtinComponents, Conversation, System, Tool, User } from "../../source/packages/prompt-jsx/components.ts"
import { Fragment, jsx, jsxs, type PromptProps } from "../../source/packages/prompt-jsx/element.ts"
import { renderContent, renderToMessages } from "../../source/packages/prompt-jsx/render-prompt.ts"

test("children that render to nothing are dropped when the element is built", () => {
  const element = jsx("p", null, "kept", null, undefined, true, false, "", 0)
  assert.deepEqual(element.props.children, ["kept", 0], "numbers are content, booleans and blanks are not")
  assert.deepEqual(jsx("p", null).props.children, undefined)
  assert.deepEqual(jsxs("p", { children: ["a", null, "b"] }).props.children, ["a", "b"])
})

test("the role components produce a conversation, not one long string", () => {
  const prompt = jsxs(Fragment, {
    children: [
      jsx(System, { children: "You are a careful assistant." }),
      jsx(User, { children: "Summarise the diff." }),
      jsx(Assistant, { children: "Looking at it now." }),
      jsx(Tool, { children: "result", tool_call_id: "call-1" }),
    ],
  })
  assert.deepEqual(renderToMessages(prompt), [
    { role: "system", content: "You are a careful assistant." },
    { role: "user", content: "Summarise the diff." },
    { role: "assistant", content: "Looking at it now." },
    { role: "tool", content: "result", toolCallId: "call-1" },
  ])
})

test("the built-in registry contains each prompt role and layout component once", () => {
  assert.deepEqual(Object.keys(builtinComponents), ["System", "User", "Assistant", "Tool", "Conversation", "Fragment"])
  assert.equal(builtinComponents.System, System)
  assert.equal(builtinComponents.User, User)
  assert.equal(builtinComponents.Assistant, Assistant)
  assert.equal(builtinComponents.Tool, Tool)
  assert.equal(builtinComponents.Conversation, Conversation)
  assert.equal(builtinComponents.Fragment, Fragment)
})

test("a named message keeps its name and a Conversation is transparent", () => {
  const messages = renderToMessages(jsx(Conversation, {
    children: [jsx(User, { name: "planner", children: "plan" }), jsx(System, { name: "house", children: "rules" })],
  }))
  assert.deepEqual(messages, [
    { role: "user", content: "plan", name: "planner" },
    { role: "system", content: "rules", name: "house" },
  ])
  assert.equal(builtinComponents.Conversation, Conversation)
})

test("headings become markdown and paragraphs are separated by a blank line", () => {
  const content = renderContent(jsxs(Fragment, {
    children: [
      jsx("h2", { children: "  Plan  " }),
      jsx("p", { children: "first paragraph" }),
      jsx("p", { children: "second paragraph" }),
      jsx("h1", { children: "   " }),
    ],
  }))
  assert.equal(content, "## Plan\n\nfirst paragraph\n\nsecond paragraph", "an empty heading renders as nothing")
})

test("lists keep their nesting with indentation", () => {
  const unordered = renderContent(jsx("ul", {
    children: [
      jsx("li", { children: "one" }),
      jsx("li", { children: ["two", jsx("ul", { children: [jsx("li", { children: "two.a" }), jsx("li", { children: "two.b" })] })] }),
    ],
  }))
  assert.equal(unordered, "- one\n- two\n  - two.a\n  - two.b")

  const ordered = renderContent(jsx("ol", {
    children: [
      jsx("li", { children: "first" }),
      jsx("li", { children: ["second", jsx("ol", { children: [jsx("li", { children: "second.a" })] })] }),
    ],
  }))
  assert.equal(ordered, "1. first\n2. second\n   1. second.a")
})

test("a list item holding only a nested list keeps its marker on the first nested line", () => {
  const content = renderContent(jsx("ol", {
    children: [
      jsx("li", { children: jsx("ul", { children: [jsx("li", { children: "nested" })] }) }),
      jsx("li", { children: "after" }),
    ],
  }))
  assert.equal(content, "1. - nested\n2. after")
})

test("a section is named by its title and carries its attributes", () => {
  const content = renderContent(jsx("section", {
    title: "Build Steps",
    priority: "high",
    optional: true,
    hidden: false,
    children: jsx("p", { children: "run the tests" }),
  }))
  assert.equal(content, '<build-steps priority="high" optional>\nrun the tests\n</build-steps>')

  assert.equal(renderContent(jsx("section", { title: "empty", children: null })), "<empty />")
  assert.equal(
    renderContent(jsx("section", { title: "quoted", note: 'say "hi"', children: "body" })),
    '<quoted note="say &quot;hi&quot;">\nbody\n</quoted>',
  )
})

test("an x tag renders its attributes and closes itself when empty", () => {
  assert.equal(renderContent(jsx("x", { tag: "user_info", path: "/tmp/a", children: "info" })), '<user_info path="/tmp/a">info</user_info>')
  assert.equal(renderContent(jsx("x", { children: null })), "<x />")
  assert.equal(renderContent(jsx("x", { tag: "note", children: "text" })), "<note>text</note>")
})

test("pre content keeps its whitespace, br becomes a newline", () => {
  assert.equal(renderContent(jsx("pre", { children: "  a   b\n  c  " })), "  a   b\n  c  ")
  assert.equal(renderContent(jsx("p", { children: ["a", jsx("br", {}), "b"] })), "a\nb")
})

test("custom components render, and unknown ones are refused", () => {
  const Callout = (props: PromptProps) => jsx("section", { title: "callout", children: props.children })
  assert.equal(renderContent(jsx(Callout, { children: "careful" })), "<callout>\ncareful\n</callout>")
  assert.equal(
    renderContent(jsx("Greeting", { children: "hi" }), { components: { Greeting: props => `hello ${String(props.children)}` } }),
    "hello hi",
    "a component registered by name is resolved when the element is rendered",
  )
  assert.throws(() => renderToMessages(jsx("Nope", {})), /Unknown component type: Nope/)
  assert.throws(() => renderContent(jsx("Nope", {})), /Unknown component type: Nope/)
})

test("strings and numbers at the top level become user messages", () => {
  assert.deepEqual(renderToMessages("just text"), [{ role: "user", content: "just text" }])
  assert.deepEqual(renderToMessages(42), [{ role: "user", content: "42" }])
  assert.deepEqual(renderToMessages(null), [])
  assert.deepEqual(renderToMessages([jsx(System, { children: "a" }), "b"]), [
    { role: "system", content: "a" },
    { role: "user", content: "b" },
  ])
})

test("a layout tag asked for messages contributes none of its own", () => {
  assert.deepEqual(renderToMessages(jsx("ul", { children: jsx("li", { children: "x" }) })), [])
  assert.equal(renderContent(jsx("li", { children: "item" })), "- item")
})
