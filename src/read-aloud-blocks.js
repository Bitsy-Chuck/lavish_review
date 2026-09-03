// Read-aloud blocks: split an artifact into the units the Listen feature plays
// one after another, each narrated in the way its kind needs.
//
// The split works on the source file with parse5 and marks every block member
// with `data-lavish-block="<index>"` through source-offset surgery, the same
// technique html-transform.js uses, so the rest of the markup stays byte for
// byte identical. The artifact SDK reads those attributes to draw one play
// button per block; the server re-reads the file to narrate block N.
//
// Kinds: text (headings, paragraphs, lists, small containers), table, diagram
// (Mermaid or inline SVG), code (pre), and image (img, picture, video, audio,
// canvas, sketch). Consecutive text elements inside one container join one
// block up to a size limit; a heading starts a new block.

import { createHash } from "node:crypto";

import { parse } from "parse5";

export const BLOCK_ATTRIBUTE = "data-lavish-block";
export const BLOCK_KIND_ATTRIBUTE = "data-lavish-block-kind";
/** Authors can keep an element out of the narration with this attribute set to "skip". */
export const SKIP_ATTRIBUTE = "data-lavish-read";
export const MAX_BLOCK_CHARS = 1200;
/** A heading starts a new block unless the group before it is this short and has no heading. */
const MERGE_KICKER_CHARS = 200;
const MAX_IMAGE_LABEL_CHARS = 200;

const SKIP_TAGS = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "link",
  "meta",
  "title",
  "base",
  "head",
  "iframe",
  "object",
  "embed",
  "button",
  "input",
  "select",
  "textarea",
  "option",
  "datalist",
  "form",
  "nav",
  "footer",
  "dialog",
  "menu",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const MEDIA_TAGS = new Set(["img", "picture", "video", "audio", "canvas"]);
const BLOCKISH_TAGS = new Set([
  "div",
  "section",
  "article",
  "main",
  "header",
  "aside",
  "table",
  "pre",
  "figure",
  "img",
  "picture",
  "video",
  "audio",
  "canvas",
  "svg",
  "ul",
  "ol",
  "dl",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "details",
  "fieldset",
  "form",
  "nav",
  "footer",
]);
const TEXT_EXCLUDED_TAGS = new Set(["script", "style", "template", "noscript"]);
const MEDIA_NOUNS = { img: "Image", picture: "Image", video: "Video", audio: "Audio clip", canvas: "Drawing" };

/**
 * @typedef {object} ReadAloudBlock
 * @property {number} index
 * @property {"text" | "table" | "diagram" | "code" | "image"} kind
 * @property {string} html Source markup of the block's elements, joined by newlines.
 * @property {string} text Plain text of the block, whitespace collapsed.
 * @property {string} context The nearest heading before the block, for table and diagram intros.
 * @property {string} label A short name for the block, shown in the chrome.
 * @property {string} hash Content identity: kind, context, and markup.
 */

/**
 * Split an artifact into read-aloud blocks and tag the markup.
 * @param {string} html
 * @returns {{ version: string, blocks: ReadAloudBlock[], tagged: string }}
 */
export function segmentArtifact(html) {
  const source = String(html ?? "");
  // parse5 treats a leading BOM as a body text token. Replace only that code point with
  // ordinary HTML whitespace so source offsets stay exact.
  const parseSource = source.startsWith("\uFEFF") ? ` ${source.slice(1)}` : source;
  const document = parse(parseSource, { sourceCodeLocationInfo: true, scriptingEnabled: true });
  const body = findBody(document);
  const state = { blocks: [], group: [], groupChars: 0, groupHasHeading: false, heading: "" };
  if (body) walk(body, state, source);
  const blocks = state.blocks;
  const version = createHash("sha256")
    .update(blocks.map((block) => `${block.kind}:${block.hash}`).join(","))
    .digest("hex")
    .slice(0, 12);
  return {
    version,
    blocks: blocks.map(({ members: _members, ...block }) => block),
    tagged: tagMembers(source, blocks),
  };
}

/**
 * The spoken text of an image block. No model is involved: the picture cannot be read,
 * so the narration names it and repeats its alt text or caption when the author gave one.
 * @param {Pick<ReadAloudBlock, "html">} block
 */
export function imageNarration(block) {
  const fragment = parse(`<body>${block.html}</body>`, { scriptingEnabled: true });
  const body = findBody(fragment);
  const media = body ? findFirst(body, (el) => MEDIA_TAGS.has(el.tagName) || hasClass(el, "lavish-sketch")) : null;
  const noun = media ? (hasClass(media, "lavish-sketch") ? "Sketch" : MEDIA_NOUNS[media.tagName] || "Image") : "Image";
  const caption = body ? findFirst(body, (el) => el.tagName === "figcaption") : null;
  const first = body ? (body.childNodes || []).find(isElement) : null;
  const label = collapse(
    (media && (attr(media, "alt") || attr(media, "aria-label") || attr(media, "title"))) ||
      (caption ? textOf(caption) : "") ||
      attr(first, "aria-label") ||
      "",
  ).slice(0, MAX_IMAGE_LABEL_CHARS);
  return label ? `${noun}: ${label.replace(/[.\s]+$/, "")}.` : `${noun}.`;
}

function walk(container, state, source) {
  for (const child of container.childNodes || []) {
    if (!isElement(child)) continue;
    const kind = classify(child);
    if (kind === "skip") continue;
    if (kind === "container") {
      flush(state, source);
      walk(child, state, source);
      continue;
    }
    if (kind === "text") {
      const text = textOf(child);
      if (!text) continue;
      // The diagram playbook puts a "Fallback:" sentence after every diagram for assistive
      // technology. The diagram block already speaks that content, so the copy is skipped.
      if (!state.group.length && state.blocks.at(-1)?.kind === "diagram" && /^fallback:/i.test(text)) continue;
      const heading = HEADING_TAGS.has(child.tagName);
      if (heading) {
        state.heading = text;
        if (state.group.length && (state.groupHasHeading || state.groupChars > MERGE_KICKER_CHARS)) {
          flush(state, source);
        }
      } else if (state.group.length && state.groupChars + text.length > MAX_BLOCK_CHARS) {
        flush(state, source);
      }
      state.group.push(child);
      state.groupChars += text.length;
      state.groupHasHeading ||= heading;
      continue;
    }
    flush(state, source);
    pushBlock(state, [child], kind, source);
  }
  flush(state, source);
}

function flush(state, source) {
  if (!state.group.length) return;
  pushBlock(state, state.group, "text", source);
  state.group = [];
  state.groupChars = 0;
  state.groupHasHeading = false;
}

function pushBlock(state, members, kind, source) {
  const located = members.filter((el) => el.sourceCodeLocation?.startTag);
  if (!located.length) return;
  const html = located
    .map((el) => source.slice(el.sourceCodeLocation.startOffset, el.sourceCodeLocation.endOffset))
    .join("\n");
  const text = collapse(located.map(textOf).join(" "));
  const context = kind === "text" ? "" : state.heading;
  state.blocks.push({
    index: state.blocks.length,
    kind,
    html,
    text,
    context,
    label: labelFor(kind, text),
    hash: createHash("sha256").update(`${kind}\n${context}\n${html}`).digest("hex").slice(0, 16),
    members: located,
  });
}

function classify(el) {
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag) || isHidden(el)) return "skip";
  if (hasClass(el, "mermaid")) return "diagram";
  if (hasClass(el, "lavish-sketch")) return "image";
  if (tag === "table") return "table";
  if (tag === "pre") return "code";
  if (MEDIA_TAGS.has(tag)) return "image";
  if (tag === "svg") return "diagram";
  if (tag === "figure") {
    if (findFirst(el, (node) => node !== el && hasClass(node, "mermaid"))) return "diagram";
    if (findFirst(el, (node) => node.tagName === "table")) return "table";
    if (findFirst(el, (node) => node.tagName === "pre")) return "code";
    if (findFirst(el, (node) => node !== el && node.tagName === "svg")) return "diagram";
    if (findFirst(el, (node) => MEDIA_TAGS.has(node.tagName))) return "image";
    return "text";
  }
  if (hasDirectText(el)) return "text";
  if (findFirst(el, (node) => node !== el && BLOCKISH_TAGS.has(node.tagName))) return "container";
  return "text";
}

function isHidden(el) {
  if (attr(el, "hidden") !== null) return true;
  if (attr(el, "aria-hidden") === "true") return true;
  if (attr(el, "data-lavish-ui") !== null) return true;
  if (attr(el, SKIP_ATTRIBUTE) === "skip") return true;
  const style = attr(el, "style") || "";
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
  const classes = classList(el);
  return (
    classes.includes("hidden") && !classes.some((name) => /^(sm|md|lg|xl|2xl):(block|flex|grid|inline)/.test(name))
  );
}

function labelFor(kind, text) {
  if (kind === "text") return text.length > 60 ? `${text.slice(0, 57).trimEnd()}...` : text;
  return { table: "Table", diagram: "Diagram", code: "Code", image: "Image" }[kind] || kind;
}

/**
 * Insert the block attributes right after each member's tag name. Insertions run from the
 * end of the source to the start so earlier offsets stay valid.
 */
function tagMembers(source, blocks) {
  const insertions = [];
  for (const block of blocks) {
    for (const el of block.members) {
      const start = el.sourceCodeLocation.startTag.startOffset;
      const offset = start + 1 + el.tagName.length;
      const tagText = source.slice(start + 1, offset);
      const next = source[offset];
      if (tagText.toLowerCase() !== el.tagName.toLowerCase()) continue;
      if (!(next === undefined || next === ">" || next === "/" || /\s/.test(next))) continue;
      insertions.push({
        offset,
        text: ` ${BLOCK_ATTRIBUTE}="${block.index}" ${BLOCK_KIND_ATTRIBUTE}="${block.kind}"`,
      });
    }
  }
  insertions.sort((a, b) => b.offset - a.offset);
  let result = source;
  for (const { offset, text } of insertions) {
    result = result.slice(0, offset) + text + result.slice(offset);
  }
  return result;
}

function findBody(document) {
  const html = (document.childNodes || []).find((node) => isElement(node) && node.tagName === "html");
  return html ? (html.childNodes || []).find((node) => isElement(node) && node.tagName === "body") : null;
}

function findFirst(root, predicate) {
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (!isElement(node)) continue;
    if (predicate(node)) return node;
    for (const child of node.childNodes || []) queue.push(child);
  }
  return null;
}

function isElement(node) {
  return Boolean(node && typeof node.tagName === "string");
}

function attr(el, name) {
  if (!el) return null;
  const found = (el.attrs || []).find((attribute) => attribute.name === name);
  return found ? found.value : null;
}

function classList(el) {
  return (attr(el, "class") || "").split(/\s+/).filter(Boolean);
}

function hasClass(el, name) {
  return classList(el).includes(name);
}

function hasDirectText(el) {
  return (el.childNodes || []).some((node) => node.nodeName === "#text" && /\S/.test(node.value || ""));
}

function textOf(el) {
  const parts = [];
  const visit = (node) => {
    if (node.nodeName === "#text") {
      parts.push(node.value || "");
      return;
    }
    if (!isElement(node) || TEXT_EXCLUDED_TAGS.has(node.tagName)) return;
    for (const child of node.childNodes || []) visit(child);
    if (BLOCKISH_TAGS.has(node.tagName) || ["br", "li", "tr", "td", "th"].includes(node.tagName)) parts.push(" ");
  };
  visit(el);
  return collapse(parts.join(""));
}

function collapse(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
