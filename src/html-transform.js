import { LAYOUT_SAFETY_CSS_SNIPPET, LAYOUT_SAFETY_OPT_OUT_ATTRIBUTE } from "./design-reference.js";

// Without this a phone lays the artifact out at its ~980px fallback width and scales the result
// down, which is the whole "everything is tiny" experience. The chrome has always emitted one for
// itself (createChromeHtml); the artifact document never got one.
export const LAVISH_VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">';

const HEAD_OPEN = /<head\b[^>]*>/i;
const HEAD_CLOSE = /<\/head\s*>/i;
const HTML_OPEN = /<html\b[^>]*>/i;
const CHARSET_META = /<meta\b[^>]*\bcharset\s*=[^>]*>/i;
const VIEWPORT_META = /<meta\b[^>]*\bname\s*=\s*["']?viewport\b/i;
const LAYOUT_SAFETY_MARKER = new RegExp(`\\b${LAYOUT_SAFETY_OPT_OUT_ATTRIBUTE}\\b`, "i");
// Enough of the document start to hold a <head> preamble; the charset declaration only has to
// survive the parser's first-1024-bytes sniff, so there is no reason to scan further than that.
const HEAD_PREAMBLE_BYTES = 1024;

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
  const head = HEAD_OPEN.exec(source);
  if (!head) return injectCharsetIntoHeadlessDocument(source);

  const at = head.index + head[0].length;
  const close = HEAD_CLOSE.exec(source.slice(at));
  const headEnd = close ? at + close.index : source.length;
  const charset = CHARSET_META.exec(source.slice(at, headEnd));
  if (!charset) {
    return `${source.slice(0, at)}${charsetTagFor(source)}${source.slice(at)}`;
  }

  const charsetAt = at + charset.index;
  if (charsetAt === at) return source;
  return source.slice(0, at) + charset[0] + source.slice(at, charsetAt) + source.slice(charsetAt + charset[0].length);
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
  const head = HEAD_OPEN.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    const charset = CHARSET_META.exec(html.slice(at, at + HEAD_PREAMBLE_BYTES));
    return charset ? at + charset.index + charset[0].length : at;
  }
  const htmlOpen = HTML_OPEN.exec(html);
  if (htmlOpen) return htmlOpen.index + htmlOpen[0].length;
  // Fragment with no <html>/<head> at all: the browser builds an implied <head> for whatever leads
  // the document. Preserve a leading charset ahead of later injections there too.
  const charset = CHARSET_META.exec(html.slice(0, HEAD_PREAMBLE_BYTES));
  return charset ? charset.index + charset[0].length : 0;
}

function injectCharsetIntoHeadlessDocument(source) {
  const tag = charsetTagFor(source);
  const htmlOpen = HTML_OPEN.exec(source);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${source.slice(0, at)}<head>${tag}</head>${source.slice(at)}`;
  }

  // Keep a BOM and an XML declaration at the absolute start. Fragments have an implied head in an
  // HTML parser; an XHTML/XML fragment gets the XML-compatible self-closing spelling.
  let at = source.startsWith("\uFEFF") ? 1 : 0;
  const xml = /^<\?xml\b[^?]*(?:\?(?!>)[^?]*)*\?>/i.exec(source.slice(at));
  if (xml) at += xml[0].length;
  return `${source.slice(0, at)}${tag}${source.slice(at)}`;
}

function charsetTagFor(source) {
  return /^\uFEFF?\s*<\?xml\b/i.test(source) ? '<meta charset="utf-8" />' : '<meta charset="utf-8">';
}
