// Prettier has no option for the emphasis marker; rumdl MD049 requires "*".
import * as markdown from "prettier/plugins/markdown";

const base = markdown.printers.mdast;
const nestedMarkers = new Set(["emphasis", "strong"]);

function print(path, options, printChildren, args) {
  const doc = base.print(path, options, printChildren, args);
  const { node } = path;
  if (node.type !== "emphasis" || !Array.isArray(doc) || doc[0] !== "_" || doc.at(-1) !== "_") {
    return doc;
  }
  // "*" next to a nested "*" marker would merge into "**" and change the meaning.
  if (nestedMarkers.has(node.children[0]?.type) || nestedMarkers.has(node.children.at(-1)?.type)) {
    return doc;
  }
  return ["*", ...doc.slice(1, -1), "*"];
}

// Prettier takes the printer from the plugin that supplied the parser, so the parser is re-exported.
export const parsers = { markdown: markdown.parsers.markdown };
export const printers = { mdast: { ...base, print } };
