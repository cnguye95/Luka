// HTML sources become markdown via turndown (handoff.md §6.1).
import TurndownService from "turndown";

export function htmlToMarkdown(html: string): string {
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  service.remove(["script", "style", "noscript"]);
  const markdown = service.turndown(html).trim();
  return markdown === "" ? "" : `${markdown}\n`;
}
