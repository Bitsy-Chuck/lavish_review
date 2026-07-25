import assert from "node:assert/strict";
import test from "node:test";

import { LAYOUT_SAFETY_CSS_SNIPPET } from "../src/design-reference.js";
import {
  hasViewportMeta,
  injectArtifactBaseLayer,
  injectLavishSdk,
  LAVISH_VIEWPORT_META,
  shouldInjectLayoutSafety,
} from "../src/html-transform.js";

test("injects the Lavish SDK before the closing body tag", () => {
  const html = "<!doctype html><html><body><h1>Hi</h1></body></html>";
  const result = injectLavishSdk(html, "abc123");

  assert.match(result, /<script src="\/sdk\.js\?key=abc123"><\/script><\/body>/);
});

test("does not inject Tailwind or DaisyUI design assets so the saved file stays portable", () => {
  const html = '<!doctype html><html><head><title>Hi</title></head><body><h1 class="btn">Hi</h1></body></html>';
  const result = injectLavishSdk(html, "abc123");

  assert.doesNotMatch(result, /\/design\/daisyui\.css/);
  assert.doesNotMatch(result, /\/design\/daisyui-themes\.css/);
  assert.doesNotMatch(result, /\/design\/tailwindcss-browser\.js/);
  assert.doesNotMatch(result, /data-lavish-design/);
});

// Replaces an assertion that pinned the <head> as untouched. Layout safety used to be optional
// boilerplate an agent had to remember to paste, which is exactly why overflow kept coming back and
// why every artifact laid out at the ~980px desktop fallback on a phone. Both are now structural.
test("adds the viewport meta and the containment layer to the head", () => {
  const html = "<!doctype html><html><head><title>Hi</title></head><body><h1>Hi</h1></body></html>";
  const result = injectLavishSdk(html, "abc123");

  assert.equal(
    result,
    "<!doctype html><html><head>" +
      LAVISH_VIEWPORT_META +
      LAYOUT_SAFETY_CSS_SNIPPET +
      '<title>Hi</title></head><body><h1>Hi</h1><script src="/sdk.js?key=abc123"></script></body></html>',
  );
});

test("keeps an existing meta charset ahead of the injected base layer", () => {
  // The parser only honors a charset declaration inside the first 1024 bytes, and the containment
  // layer is big enough to push one past that boundary.
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>Hi</title></head><body>x</body></html>';
  const result = injectArtifactBaseLayer(html);

  assert.ok(result.indexOf('<meta charset="utf-8">') < result.indexOf(LAVISH_VIEWPORT_META));
  assert.match(result, /<head><meta charset="utf-8"><meta name="viewport"/);
});

test("never adds a second viewport meta when the artifact declares its own", () => {
  const html =
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">' +
    "</head><body>x</body></html>";
  const result = injectLavishSdk(html, "abc123");

  assert.equal(result.match(/name="viewport"/g).length, 1);
  assert.match(result, /maximum-scale=5/);
  assert.ok(hasViewportMeta(html));
});

test("the containment layer is opt-out per artifact", () => {
  const html = '<!doctype html><html data-lavish-layout-safety="off"><head></head><body>x</body></html>';
  const result = injectLavishSdk(html, "abc123");

  assert.doesNotMatch(result, /@layer lavish-safety/);
  // The viewport meta is not part of the opt-out; it is not a style.
  assert.match(result, /name="viewport"/);
  assert.equal(shouldInjectLayoutSafety(html), false);
});

test("does not stack a second containment layer on an artifact that already carries one", () => {
  const once = injectArtifactBaseLayer("<!doctype html><html><head></head><body>x</body></html>");
  const twice = injectArtifactBaseLayer(once);

  assert.equal(once, twice);
  assert.equal(once.match(/@layer lavish-safety/g).length, 1);
});

test("containment layer stays containment-only and yields to the artifact's own CSS", () => {
  // A base layer that restyles an existing artifact is a failure, so this pins the negative space:
  // no color, no spacing, no typography, and everything inside a layer any unlayered rule outranks.
  assert.match(LAYOUT_SAFETY_CSS_SNIPPET, /@layer lavish-safety \{/);
  assert.match(LAYOUT_SAFETY_CSS_SNIPPET, /box-sizing: border-box/);
  assert.match(LAYOUT_SAFETY_CSS_SNIPPET, /min-width: 0/);
  assert.match(LAYOUT_SAFETY_CSS_SNIPPET, /overflow-wrap: anywhere/);
  assert.match(LAYOUT_SAFETY_CSS_SNIPPET, /:where\(pre\) \{ max-width: 100%; overflow-x: auto; \}/);
  assert.match(LAYOUT_SAFETY_CSS_SNIPPET, /:where\(code, kbd, samp\) \{ overflow-wrap: anywhere; \}/);
  assert.doesNotMatch(LAYOUT_SAFETY_CSS_SNIPPET, /(^|[^-])color:/m);
  assert.doesNotMatch(LAYOUT_SAFETY_CSS_SNIPPET, /font-|background|margin:|padding:|border-radius/);
});

// Established by measurement in the diagram-guidance work: with `max-width: 100%` in force, a wide
// Mermaid diagram using `useMaxWidth: false` inside an `overflow-x: auto` wrapper still shrinks to
// fit and produces no scrollbar at all - and its computed max-width reads back as "100%", which
// also defeats shrink detection. Universalizing this CSS must not universalize that bug.
test("containment layer exempts media inside a horizontal scroll container", () => {
  assert.match(LAYOUT_SAFETY_CSS_SNIPPET, /\.overflow-x-auto/);
  assert.match(LAYOUT_SAFETY_CSS_SNIPPET, /\.overflow-x-scroll/);
  assert.match(LAYOUT_SAFETY_CSS_SNIPPET, /\[data-lavish-scroll-x\]/);
  assert.match(LAYOUT_SAFETY_CSS_SNIPPET, /max-width: none;/);
});

// `height: auto` on an <iframe> is not containment: unlike raster media and viewBox'd SVG it has no
// intrinsic ratio, so `auto` collapses it to the 150px default and outranks a `height` attribute.
test("containment layer bounds iframe width without collapsing its height", () => {
  assert.match(LAYOUT_SAFETY_CSS_SNIPPET, /:where\(img, svg, video, canvas, iframe\)[^\n]*max-width: 100%/);
  assert.match(LAYOUT_SAFETY_CSS_SNIPPET, /:where\(img, svg, video, canvas\)[^\n]*height: auto/);
  assert.doesNotMatch(LAYOUT_SAFETY_CSS_SNIPPET, /iframe\)[^\n]*height: auto/);
});

test("appends the Lavish SDK when the artifact has no body tag", () => {
  const result = injectLavishSdk("<h1>Hi</h1>", "abc123");

  assert.equal(
    result,
    `${LAVISH_VIEWPORT_META}${LAYOUT_SAFETY_CSS_SNIPPET}<h1>Hi</h1>\n<script src="/sdk.js?key=abc123"></script>`,
  );
});
