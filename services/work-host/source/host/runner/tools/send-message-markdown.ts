export function encodeMarkdownImageDestination(url: string): string {
  return `<${url.replace(/[<>\r\n]/g, encodeURIComponent)}>`;
}

export function encodeTextContent(message: {
  readonly content: string;
  readonly images?: readonly { readonly url: string; readonly alt?: string }[];
}): string {
  if ((message.images?.length ?? 0) === 0) return message.content;
  const markdownLines = message.images!.map((image) => {
    const altText = (image.alt ?? "").replace(/[[\]\n]/g, " ").trim();
    return `![${altText}](${encodeMarkdownImageDestination(image.url)})`;
  });
  return `${message.content}\n\n${markdownLines.join("\n")}`;
}
