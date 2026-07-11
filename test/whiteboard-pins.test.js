import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

// The Mermaid-to-Excalidraw converter reaches into mermaid's rendered DOM and
// diagram.db internals, and versions past 11.13.0 silently degrade class/ER/
// state diagrams and subgraph flowcharts to non-editable image fallbacks
// (mermaid-to-excalidraw#108). The whiteboard bundle therefore pins mermaid
// EXACTLY - independent of the newer Mermaid version artifacts use for offline
// rendering (the /design/mermaid.esm.min.mjs the de-CDN work vendors). The two
// mermaids diverge on purpose: the whiteboard resolves its 11.12.1 transitively
// through the exactly-pinned converter, while the top-level dependency is the
// newer rendering mermaid. If a bump to either is attempted, this test forces a
// deliberate re-probe of native conversion before it lands.

const CONVERTER_PIN = "2.2.2";
const EDITOR_PIN = "0.18.1";
const WHITEBOARD_MERMAID_PIN = "11.12.1";
const RENDERING_MERMAID_PIN = "11.15.0";

const require = createRequire(import.meta.url);

function readJsonPath(absPath) {
  return JSON.parse(readFileSync(absPath, "utf8"));
}

function readJson(relUrl) {
  return JSON.parse(readFileSync(new URL(relUrl, import.meta.url), "utf8"));
}

test("whiteboard converter and editor are pinned exactly in package.json", () => {
  const pkg = readJson("../package.json");
  assert.equal(
    pkg.devDependencies["@excalidraw/mermaid-to-excalidraw"],
    CONVERTER_PIN,
    `@excalidraw/mermaid-to-excalidraw must be pinned exactly to ${CONVERTER_PIN}`,
  );
  assert.equal(
    pkg.devDependencies["@excalidraw/excalidraw"],
    EDITOR_PIN,
    `@excalidraw/excalidraw must be pinned exactly to ${EDITOR_PIN}`,
  );
});

test("the rendering mermaid the artifacts load is pinned in dependencies", () => {
  // The de-CDN offline rendering path (build.js copies node_modules/mermaid into
  // dist/design) uses the top-level dependency, which is deliberately newer than
  // the whiteboard's 11.12.1.
  const pkg = readJson("../package.json");
  assert.equal(pkg.dependencies.mermaid, RENDERING_MERMAID_PIN);
  assert.equal(readJson("../node_modules/mermaid/package.json").version, RENDERING_MERMAID_PIN);
});

test("the mermaid the whiteboard bundles is the pinned version", () => {
  // esbuild bundles src/whiteboard-frame.js, which imports the converter; the
  // converter depends on exactly 11.12.1, so it resolves its own nested mermaid
  // regardless of the newer top-level rendering mermaid. Resolve mermaid the way
  // the converter (and thus the bundle) does and assert that pinned version.
  const converterPkgPath = require.resolve("@excalidraw/mermaid-to-excalidraw/package.json");
  const bundledMermaidPkgPath = require.resolve("mermaid/package.json", { paths: [converterPkgPath] });
  assert.equal(readJsonPath(bundledMermaidPkgPath).version, WHITEBOARD_MERMAID_PIN);
});

test("the converter and editor resolve to their pinned versions", () => {
  assert.equal(readJson("../node_modules/@excalidraw/mermaid-to-excalidraw/package.json").version, CONVERTER_PIN);
  assert.equal(readJson("../node_modules/@excalidraw/excalidraw/package.json").version, EDITOR_PIN);
});
