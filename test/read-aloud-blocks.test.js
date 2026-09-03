import assert from "node:assert/strict";
import test from "node:test";

import { BLOCK_ATTRIBUTE, MAX_BLOCK_CHARS, imageNarration, segmentArtifact } from "../src/read-aloud-blocks.js";

const page = (body) =>
  `<!doctype html><html><head><title>T</title><style>p{}</style></head><body>${body}</body></html>`;

function kinds(result) {
  return result.blocks.map((block) => block.kind);
}

test("a heading and its paragraphs form one text block; the next heading starts another", () => {
  const { blocks } = segmentArtifact(page("<h2>Plan</h2><p>One.</p><p>Two.</p><h2>Risks</h2><p>Three.</p>"));
  assert.deepEqual(kinds({ blocks }), ["text", "text"]);
  assert.equal(blocks[0].text, "Plan One. Two.");
  assert.equal(blocks[0].html, "<h2>Plan</h2>\n<p>One.</p>\n<p>Two.</p>");
  assert.equal(blocks[1].text, "Risks Three.");
  assert.equal(blocks[0].label, "Plan One. Two.");
});

test("a short kicker line merges into the title block that follows it", () => {
  const { blocks } = segmentArtifact(page("<p>Kicker</p><h1>Title</h1><p>Intro.</p>"));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "Kicker Title Intro.");
});

test("tables, diagrams, code, and images stand alone and carry the heading as context", () => {
  const { blocks } = segmentArtifact(
    page(
      "<h2>Costs</h2><p>Lead.</p>" +
        '<div class="overflow-x-auto"><table><tr><th>A</th></tr><tr><td>1</td></tr></table></div>' +
        '<div class="mermaid">flowchart TD\n  A --> B</div>' +
        "<p>Fallback: A goes to B.</p>" +
        "<pre>npm test</pre>" +
        '<figure><img src="c.png" alt="Cost chart"><figcaption>Costs by month</figcaption></figure>' +
        "<p>Tail.</p>",
    ),
  );
  assert.deepEqual(kinds({ blocks }), ["text", "table", "diagram", "code", "image", "text"]);
  assert.equal(blocks[1].context, "Costs");
  assert.equal(blocks[1].label, "Table");
  assert.match(blocks[1].html, /^<table>/);
  assert.equal(blocks[2].context, "Costs");
  assert.match(blocks[2].html, /flowchart TD/);
  assert.equal(blocks[3].html, "<pre>npm test</pre>");
  assert.equal(blocks[4].label, "Image");
  assert.equal(blocks[5].text, "Tail.");
});

test("the fallback sentence after a diagram is not read twice, but other prose is", () => {
  const { blocks } = segmentArtifact(
    page('<div class="mermaid">flowchart TD\n A-->B</div><p>Fallback: A to B.</p><p>Real prose.</p>'),
  );
  assert.deepEqual(kinds({ blocks }), ["diagram", "text"]);
  assert.equal(blocks[1].text, "Real prose.");
});

test("cards and steps each become their own block", () => {
  const { blocks } = segmentArtifact(
    page(
      '<div class="grid">' +
        '<div class="card"><div class="card-body"><h3>A</h3><ul><li>a1</li><li>a2</li></ul><p>note</p></div></div>' +
        '<div class="card"><div class="card-body"><h3>B</h3><p>b</p></div></div>' +
        "</div>" +
        '<ul class="steps"><li><div><p>Step one</p><p>detail</p></div></li><li><div><p>Step two</p></div></li></ul>',
    ),
  );
  assert.deepEqual(
    blocks.map((block) => block.text),
    ["A a1 a2 note", "B b", "Step one detail", "Step two"],
  );
});

test("scripts, styles, forms, nav, footer, hidden, aria-hidden, and opted-out elements are skipped", () => {
  const { blocks } = segmentArtifact(
    page(
      "<script>x()</script><style>p{}</style><nav><p>menu</p></nav><p>Keep.</p>" +
        '<form><label>Q?</label><input></form><p hidden>no</p><p aria-hidden="true">no</p>' +
        '<p style="display:none">no</p><p class="hidden">no</p><p class="hidden md:block">yes</p>' +
        '<p data-lavish-read="skip">no</p><footer><p>sources</p></footer>',
    ),
  );
  assert.deepEqual(
    blocks.map((block) => block.text),
    ["Keep. yes"],
  );
});

test("long runs of prose split at the size limit", () => {
  const paragraph = `<p>${"word ".repeat(100).trim()}</p>`; // 499 chars each
  const { blocks } = segmentArtifact(page(paragraph.repeat(5)));
  assert.equal(blocks.length, 3);
  for (const block of blocks) assert.ok(block.text.length <= MAX_BLOCK_CHARS);
});

test("a container with its own text is one block, and an inline svg icon stays inside prose", () => {
  const { blocks } = segmentArtifact(
    page(
      '<div>Lead text <p>inner</p></div><p>Icon <svg><path d="M0 0"/></svg> here.</p><svg><title>Figure</title></svg>',
    ),
  );
  assert.deepEqual(kinds({ blocks }), ["text", "diagram"]);
  assert.equal(blocks[0].text, "Lead text inner Icon here.");
  assert.equal(blocks[1].label, "Diagram");
});

test("tagging inserts the block attributes and leaves everything else byte for byte", () => {
  const source = page('<h2 class="t">Plan</h2><p>One.</p><table><tr><td>1</td></tr></table><IMG src="a.png">');
  const { tagged, blocks } = segmentArtifact(source);
  assert.equal(blocks.length, 3);
  assert.ok(tagged.includes(`<h2 ${BLOCK_ATTRIBUTE}="0" data-lavish-block-kind="text" class="t">Plan</h2>`));
  assert.ok(tagged.includes(`<p ${BLOCK_ATTRIBUTE}="0" data-lavish-block-kind="text">One.</p>`));
  assert.ok(tagged.includes(`<table ${BLOCK_ATTRIBUTE}="1" data-lavish-block-kind="table">`));
  assert.ok(tagged.includes(`<IMG ${BLOCK_ATTRIBUTE}="2" data-lavish-block-kind="image" src="a.png">`));
  const stripped = tagged.replace(/ data-lavish-block="\d+" data-lavish-block-kind="\w+"/g, "");
  assert.equal(stripped, source);
});

test("a BOM keeps offsets exact and an empty page yields no blocks", () => {
  const source = `\uFEFF${page("<p>Hi</p>")}`;
  const { tagged, blocks } = segmentArtifact(source);
  assert.equal(blocks.length, 1);
  assert.ok(tagged.startsWith("\uFEFF"));
  assert.ok(tagged.includes('<p data-lavish-block="0" data-lavish-block-kind="text">Hi</p>'));
  assert.deepEqual(segmentArtifact(page("<script>only()</script>")).blocks, []);
  assert.deepEqual(segmentArtifact("").blocks, []);
});

test("the version follows the content and the block hash follows kind, context, and markup", () => {
  const a = segmentArtifact(page("<h2>X</h2><table><tr><td>1</td></tr></table>"));
  const b = segmentArtifact(page("<h2>X</h2><table><tr><td>1</td></tr></table>"));
  const c = segmentArtifact(page("<h2>Y</h2><table><tr><td>1</td></tr></table>"));
  assert.equal(a.version, b.version);
  assert.notEqual(a.version, c.version);
  assert.equal(a.blocks[1].hash, b.blocks[1].hash);
  assert.notEqual(a.blocks[1].hash, c.blocks[1].hash, "the heading context is part of a table's identity");
});

test("imageNarration names the medium and repeats the alt text or caption", () => {
  assert.equal(imageNarration({ html: '<img src="x.png" alt="Bar chart of costs">' }), "Image: Bar chart of costs.");
  assert.equal(imageNarration({ html: '<img src="x.png">' }), "Image.");
  assert.equal(
    imageNarration({ html: '<figure><video src="v.mp4"></video><figcaption>Demo run.</figcaption></figure>' }),
    "Video: Demo run.",
  );
  assert.equal(imageNarration({ html: '<canvas aria-label="Latency chart"></canvas>' }), "Drawing: Latency chart.");
  assert.equal(imageNarration({ html: '<section class="lavish-sketch"></section>' }), "Sketch.");
  assert.equal(imageNarration({ html: `<img alt="${"a".repeat(300)}">` }).length, 200 + "Image: .".length);
});
