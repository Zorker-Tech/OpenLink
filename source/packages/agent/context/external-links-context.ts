/**
 * Search results the user attached, presented as things the agent already knows.
 *
 * A model told "here are search results" tends to answer with a disclaimer about not having internet
 * access, which is both wrong and unhelpful. So the block says the results are known to it and asks it
 * not to disclaim, and it asks for citations — the point of attaching results is that the answer can be
 * traced back to them.
 */

export interface ExternalLinkContent {
  readonly url: string
  readonly title: string
  readonly content: string
}

export function renderExternalLinksContext(links: readonly ExternalLinkContent[]): string | undefined {
  if (links.length === 0) return undefined
  let linksText = `<external_links>
### Potentially Relevant Websearch Results

You should respond as if these information are known to you. Refrain from saying "I am unable to browse the internet" or "I don't have access to the internet" or "I'm unable to provide real-time news updates". This is your internet search results. Please always cite any links you referenced from the above search results in markdown format.

-------
`
  for (const link of links) {
    linksText += `Website URL: ${link.url}
Website Title: ${link.title}
Website Content:
${link.content}
____

`
  }
  linksText += `</external_links>`
  return linksText
}
