import { LAYOUT_SAFETY_CSS_SNIPPET, LAYOUT_SAFETY_OPT_OUT_ATTRIBUTE } from "./design-reference.js";

// Without this a phone lays the artifact out at its ~980px fallback width and scales the result
// down, which is the whole "everything is tiny" experience. The chrome has always emitted one for
// itself (createChromeHtml); the artifact document never got one.
export const LAVISH_VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">';

const HEAD_OPEN = /<head\b[^>]*>/i;
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
  const source = String(html ?? "");
  const prelude =
    (hasViewportMeta(source) ? "" : LAVISH_VIEWPORT_META) +
    (shouldInjectLayoutSafety(source) ? LAYOUT_SAFETY_CSS_SNIPPET : "");
  if (!prelude) return source;

  const at = headInsertionIndex(source);
  return `${source.slice(0, at)}${prelude}${source.slice(at)}`;
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
function headInsertionIndex(html) {
  const head = HEAD_OPEN.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    const charset = CHARSET_META.exec(html.slice(at, at + HEAD_PREAMBLE_BYTES));
    return charset ? at + charset.index + charset[0].length : at;
  }
  const htmlOpen = HTML_OPEN.exec(html);
  if (htmlOpen) return htmlOpen.index + htmlOpen[0].length;
  // Fragment with no <html>/<head> at all: the browser builds an implied <head> for whatever leads
  // the document, so leading the fragment is the same insertion point.
  return 0;
}
