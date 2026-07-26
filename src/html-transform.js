import { parse } from "parse5";

import { LAYOUT_SAFETY_CSS_SNIPPET, LAYOUT_SAFETY_OPT_OUT_ATTRIBUTE } from "./design-reference.js";

// Without this a phone lays the artifact out at its ~980px fallback width and scales the result
// down, which is the whole "everything is tiny" experience. The chrome has always emitted one for
// itself (createChromeHtml); the artifact document never got one.
export const LAVISH_VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">';

const VIEWPORT_META = /<meta\b[^>]*\bname\s*=\s*["']?viewport\b/i;
const LAYOUT_SAFETY_MARKER = new RegExp(`\\b${LAYOUT_SAFETY_OPT_OUT_ATTRIBUTE}\\b`, "i");

/** True when the artifact already declares its own viewport, so Lavish must not add a second one. */
export function hasViewportMeta(html) {
  return VIEWPORT_META.test(String(html ?? ""));
}

/**
 * True when Lavish should add the containment layer. One attribute answers both questions it needs
 * to ask: `data-lavish-layout-safety="off"` on the artifact is the documented opt-out, and the
 * injected <style> carries the same attribute, so a document that already has the layer - injected
 * here, or pasted from `lavish-axi design` - never collects a second copy.
 */
export function shouldInjectLayoutSafety(html) {
  return !LAYOUT_SAFETY_MARKER.test(String(html ?? ""));
}

/**
 * Prepend the artifact base layer: a viewport meta (unless the artifact declares one) and the
 * containment CSS layer (unless the artifact opted out). Both go at the very start of <head> so the
 * `@layer lavish-safety` at-rule is the FIRST layer the document declares - layer order follows
 * first appearance, so a stylesheet that got in ahead of it would sort its own layers *above* ours
 * and the base layer would start overriding the artifact instead of yielding to it.
 */
export function injectArtifactBaseLayer(html) {
  const source = ensureEarlyCharset(html);
  const prelude =
    (hasViewportMeta(source) ? "" : LAVISH_VIEWPORT_META) +
    (shouldInjectLayoutSafety(source) ? LAYOUT_SAFETY_CSS_SNIPPET : "");
  if (!prelude) return source;

  const at = headInsertionIndex(source);
  return `${source.slice(0, at)}${prelude}${source.slice(at)}`;
}

/**
 * Put an HTML encoding declaration first in <head>. Browsers only inspect the first 1024 bytes for
 * a meta charset when no transport-level encoding is available (notably for file:// exports).
 */
export function ensureEarlyCharset(html) {
  const source = String(html ?? "");
  const structure = documentStructure(source);
  const headStart = structure.head?.sourceCodeLocation?.startTag?.endOffset;
  if (headStart !== undefined) {
    const charset = structure.charset?.sourceCodeLocation;
    if (!charset) {
      return `${source.slice(0, headStart)}${charsetTagFor(source)}${source.slice(headStart)}`;
    }
    if (charset.startOffset === headStart) return source;
    const tag = source.slice(charset.startOffset, charset.endOffset);
    return (
      source.slice(0, headStart) + tag + source.slice(headStart, charset.startOffset) + source.slice(charset.endOffset)
    );
  }

  return injectCharsetIntoHeadlessDocument(source, structure);
}

export function injectLavishSdk(html, key) {
  const withBaseLayer = injectArtifactBaseLayer(html);
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}"></script>`;
  if (/<\/body\s*>/i.test(withBaseLayer)) {
    return withBaseLayer.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  return `${withBaseLayer}\n${script}`;
}

// Insert after an existing <meta charset> rather than before it: the parser only honors a charset
// declaration inside the first 1024 bytes, and the containment layer is big enough to push one past
// that boundary and silently change how the artifact decodes.
export function headInsertionIndex(html) {
  const source = String(html ?? "");
  const structure = documentStructure(source);
  const charset = structure.charset?.sourceCodeLocation;
  if (charset) return charset.endOffset;
  return (
    elementStartEndOffset(structure.head) ?? elementStartEndOffset(structure.html) ?? headlessInsertionIndex(source)
  );
}

function injectCharsetIntoHeadlessDocument(source, structure) {
  const charset = structure.charset?.sourceCodeLocation;
  const tag = charset ? source.slice(charset.startOffset, charset.endOffset) : charsetTagFor(source);
  const htmlStart = elementStartEndOffset(structure.html);
  if (htmlStart !== undefined) {
    if (!charset) return `${source.slice(0, htmlStart)}<head>${tag}</head>${source.slice(htmlStart)}`;
    return (
      source.slice(0, htmlStart) +
      `<head>${tag}</head>` +
      source.slice(htmlStart, charset.startOffset) +
      source.slice(charset.endOffset)
    );
  }

  // Keep a BOM and an XML declaration at the absolute start. Fragments have an implied head in an
  // HTML parser; an XHTML/XML fragment gets the XML-compatible self-closing spelling.
  const at = headlessInsertionIndex(source);
  if (!charset) return `${source.slice(0, at)}${tag}${source.slice(at)}`;
  if (charset.startOffset === at) return source;
  return source.slice(0, at) + tag + source.slice(at, charset.startOffset) + source.slice(charset.endOffset);
}

function charsetTagFor(source) {
  return /^\uFEFF?\s*<\?xml\b/i.test(source) ? '<meta charset="utf-8" />' : '<meta charset="utf-8">';
}

function headlessInsertionIndex(source) {
  let at = source.startsWith("\uFEFF") ? 1 : 0;
  const xml = /^<\?xml\b[^?]*(?:\?(?!>)[^?]*)*\?>/i.exec(source.slice(at));
  if (xml) at += xml[0].length;
  return at;
}

function documentStructure(source) {
  // parse5 treats a leading BOM as a body text token. Replace only that code point with ordinary
  // HTML whitespace so source offsets stay exact while the explicit html/head structure is parsed.
  const parseSource = source.startsWith("\uFEFF") ? ` ${source.slice(1)}` : source;
  const document = parse(parseSource, { sourceCodeLocationInfo: true, scriptingEnabled: true });
  const html = document.childNodes.find((node) => "tagName" in node && node.tagName === "html");
  const head = html && "childNodes" in html ? html.childNodes.find((node) => node.nodeName === "head") : undefined;
  const charset = head?.childNodes.find(
    (node) => node.nodeName === "meta" && node.attrs?.some((attribute) => attribute.name === "charset"),
  );
  return { html, head, charset };
}

function elementStartEndOffset(element) {
  const location = element?.sourceCodeLocation;
  return location && "startTag" in location ? location.startTag?.endOffset : undefined;
}
