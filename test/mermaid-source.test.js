import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeHtmlEntities,
  extractWhiteboardSources,
  mermaidSourceHash,
  normalizeMermaidSource,
} from "../src/mermaid-source.js";

test("extractWhiteboardSources finds .mermaid elements in document order", () => {
  const html = `<html><body>
    <pre class="mermaid">flowchart TD
  A --> B</pre>
    <p>prose</p>
    <div class="mermaid">sequenceDiagram
  A->>B: hi</div>
  </body></html>`;
  const sources = extractWhiteboardSources(html);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].index, 0);
  assert.equal(sources[0].source, "flowchart TD\n  A --> B");
  assert.equal(sources[1].index, 1);
  assert.equal(sources[1].source, "sequenceDiagram\n  A->>B: hi");
});

test("extractWhiteboardSources decodes HTML entities in diagram text", () => {
  const html = `<pre class="mermaid">flowchart LR
  A --&gt; B{&quot;ok?&quot;}
  B --&gt; C[&amp;done&#39;]</pre>`;
  const [diagram] = extractWhiteboardSources(html);
  assert.equal(diagram.source, `flowchart LR\n  A --> B{"ok?"}\n  B --> C[&done']`);
});

test("extractWhiteboardSources preserves text exactly as parsed by the browser", () => {
  const [diagram] = extractWhiteboardSources(`<div class="mermaid">graph TD; A --&amp;gt; B</div>`);
  assert.equal(diagram.source, "graph TD; A --&gt; B");
});

test("extractWhiteboardSources requires the exact mermaid class token", () => {
  const html = `
    <div class="mermaid-like">graph TD; X-->Y</div>
    <div class="not mermaid diagram">graph TD; A-->B</div>
    <div class="mermaidish">graph TD; P-->Q</div>`;
  const sources = extractWhiteboardSources(html);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].source, "graph TD; A-->B");
});

test("extractWhiteboardSources ignores commented-out diagrams so indexes match the browser", () => {
  const html = `
    <!-- <div class="mermaid">graph TD; HIDDEN-->X</div> -->
    <div class="mermaid">graph TD; A-->B</div>`;
  const sources = extractWhiteboardSources(html);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].index, 0);
  assert.equal(sources[0].source, "graph TD; A-->B");
});

test("extractWhiteboardSources strips stray inner markup", () => {
  const html = `<div class="mermaid">graph TD; A-->B<span></span></div>`;
  assert.equal(extractWhiteboardSources(html)[0].source, "graph TD; A-->B");
});

test("extractWhiteboardSources handles single-quoted class attributes and empty input", () => {
  assert.equal(extractWhiteboardSources(`<div class='mermaid x'>graph TD; A-->B</div>`).length, 1);
  assert.deepEqual(extractWhiteboardSources(""), []);
  assert.deepEqual(extractWhiteboardSources(null), []);
});

test("extractWhiteboardSources follows HTML class attribute casing and quoting", () => {
  const html = `<div class=mermaid>graph TD; A-->B</div>
    <div CLASS="diagram mermaid">graph TD; B-->C</div>
    <div class=mermaid-like>graph TD; C-->D</div>`;
  const sources = extractWhiteboardSources(html);
  assert.deepEqual(
    sources.map(({ source }) => source),
    ["graph TD; A-->B", "graph TD; B-->C"],
  );
});

test("extractWhiteboardSources ignores raw-text and template markup", () => {
  const html = `<script>const example = '<div class="mermaid">graph TD; SCRIPT-->X</div>';</script>
    <template><div class="mermaid">graph TD; TEMPLATE-->X</div></template>
    <style>.example::after { content: '<div class="mermaid">'; }</style>
    <div class="mermaid">graph TD; A-->B</div>`;
  assert.deepEqual(extractWhiteboardSources(html), [{ index: 0, kind: "mermaid", source: "graph TD; A-->B" }]);
});

test("extractWhiteboardSources interleaves sketch blocks with diagrams in one index space", () => {
  const html = `<pre class="mermaid">graph TD; A-->B</pre>
    <div class="lavish-sketch"><script type="application/lavish-sketch+json">{"elements":[{"id":"r1","type":"rectangle","x":0}]}</script><p>fallback prose</p></div>
    <div class="mermaid">graph TD; C-->D</div>`;
  const sources = extractWhiteboardSources(html);
  assert.deepEqual(
    sources.map(({ index, kind }) => ({ index, kind })),
    [
      { index: 0, kind: "mermaid" },
      { index: 1, kind: "sketch" },
      { index: 2, kind: "mermaid" },
    ],
  );
  assert.deepEqual(JSON.parse(sources[1].source), { elements: [{ id: "r1", type: "rectangle", x: 0 }] });
});

test("sketch JSON is taken raw from the script tag without entity decoding", () => {
  const html = `<div class="lavish-sketch">
    <script type="application/lavish-sketch+json">{"label":"A &amp;&amp; <b>"}</script>
  </div>`;
  assert.equal(extractWhiteboardSources(html)[0].source, `{"label":"A &amp;&amp; <b>"}`);
});

test("a sketch script nested inside wrapper markup is still found", () => {
  const html = `<div class="lavish-sketch"><figure><script type="application/lavish-sketch+json">{"elements":[]}</script></figure></div>`;
  assert.equal(extractWhiteboardSources(html)[0].source, `{"elements":[]}`);
});

test("a sketch container without its script keeps its index with an empty source", () => {
  const html = `<div class="lavish-sketch"><p>only fallback</p></div><div class="mermaid">graph TD; A-->B</div>`;
  const sources = extractWhiteboardSources(html);
  assert.deepEqual(
    sources.map((entry) => [entry.index, entry.kind, entry.source === ""]),
    [
      [0, "sketch", true],
      [1, "mermaid", false],
    ],
  );
});

test("an element carrying both classes counts once, as a mermaid diagram", () => {
  const sources = extractWhiteboardSources(`<div class="mermaid lavish-sketch">graph TD; A-->B</div>`);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, "mermaid");
});

test("sketch scripts with other type attributes are ignored", () => {
  const html = `<div class="lavish-sketch"><script type="application/json">{"elements":[]}</script></div>`;
  assert.equal(extractWhiteboardSources(html)[0].source, "");
});

test("normalizeMermaidSource trims outer blank space but keeps inner structure", () => {
  assert.equal(normalizeMermaidSource("\n  flowchart TD\n    A --> B\n  "), "  flowchart TD\n    A --> B");
  assert.equal(normalizeMermaidSource(""), "");
});

test("mermaidSourceHash is stable across edge whitespace and differs across content", () => {
  const a = mermaidSourceHash("flowchart TD\n  A --> B");
  const b = mermaidSourceHash("\nflowchart TD\n  A --> B   \n");
  const c = mermaidSourceHash("flowchart TD\n  A --> C");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("decodeHtmlEntities decodes numeric references and double-encoded ampersands last", () => {
  assert.equal(decodeHtmlEntities("A&#39;s &#x2192; B"), "A's → B");
  assert.equal(decodeHtmlEntities("a &amp;&amp; b"), "a && b");
});
