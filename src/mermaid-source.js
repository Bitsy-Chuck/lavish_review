import crypto from "node:crypto";

import { parse } from "parse5";

// Server-side extraction of whiteboard sources from raw artifact HTML: Mermaid
// diagram text from `.mermaid` elements and agent-authored Excalidraw sketch
// JSON from `.lavish-sketch` blocks.
//
// The design snippet (`lavish-axi design`) renders diagrams from elements with
// class="mermaid" via `mermaid.run(...)`, replacing each element's text content
// with a rendered SVG in the live DOM. The artifact file on disk still holds
// the original sources, so the server - which already reads the file for every
// artifact route - is the authoritative place to recover them. Whiteboards are
// identified by their position among `.mermaid, .lavish-sketch` elements in
// document order, matching `document.querySelectorAll(".mermaid, .lavish-sketch")`
// in the browser.

// Decode the entity forms that matter for Mermaid syntax (`--&gt;`, `&quot;...`).
// Numeric references are included so authored `&#39;` quotes survive.
export function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, code) => safeFromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => safeFromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeFromCodePoint(code) {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

export const SKETCH_SCRIPT_TYPE = "application/lavish-sketch+json";

function attributeValue(node, name) {
  const attribute = Array.isArray(node.attrs) ? node.attrs.find((entry) => entry.name.toLowerCase() === name) : null;
  return attribute ? attribute.value : null;
}

function elementHasClassToken(node, token) {
  const classValue = attributeValue(node, "class");
  return Boolean(classValue && classValue.split(/[\t\n\f\r ]+/).includes(token));
}

function textContent(node) {
  if (node.nodeName === "#text") return String(node.value || "");
  return Array.isArray(node.childNodes) ? node.childNodes.map(textContent).join("") : "";
}

// A sketch block's scene JSON lives in a `script[type="application/lavish-sketch+json"]`
// descendant. Script elements are raw text in both parse5 and browsers, so the
// JSON comes back byte-exact with no entity decoding.
function sketchScriptText(node) {
  if (!Array.isArray(node.childNodes)) return "";
  for (const child of node.childNodes) {
    if (child.tagName === "script" && attributeValue(child, "type") === SKETCH_SCRIPT_TYPE) {
      return textContent(child);
    }
    const nested = sketchScriptText(child);
    if (nested) return nested;
  }
  return "";
}

// Extract whiteboard sources - Mermaid diagrams and Lavish sketch blocks -
// from raw artifact HTML in document order. Returns `[{ index, kind, source }]`
// where `index` matches the element's position among `.mermaid, .lavish-sketch`
// elements (the browser-side `diagramIndex`). An element carrying both classes
// counts once, as a Mermaid diagram; a sketch container without its scene
// script keeps its index with an empty source so browser and server never
// disagree about numbering.
export function extractWhiteboardSources(html) {
  const sources = [];

  function visit(node) {
    if (!Array.isArray(node.childNodes)) return;
    for (const child of node.childNodes) {
      if (child.tagName && elementHasClassToken(child, "mermaid")) {
        sources.push({
          index: sources.length,
          kind: "mermaid",
          source: normalizeMermaidSource(textContent(child)),
        });
      } else if (child.tagName && elementHasClassToken(child, "lavish-sketch")) {
        sources.push({
          index: sources.length,
          kind: "sketch",
          source: normalizeMermaidSource(sketchScriptText(child)),
        });
      }
      visit(child);
    }
  }

  visit(parse(String(html || "")));
  return sources;
}

// Trim outer blank lines but preserve inner indentation - Mermaid cares about
// line structure, and the hash must be stable across incidental whitespace at
// the edges of the HTML element.
export function normalizeMermaidSource(source) {
  return String(source || "")
    .replace(/^[ \t]*\r?\n/, "")
    .trimEnd();
}

// Stable identity for "did the underlying diagram change" staleness checks.
export function mermaidSourceHash(source) {
  return crypto.createHash("sha256").update(normalizeMermaidSource(source)).digest("hex").slice(0, 16);
}
