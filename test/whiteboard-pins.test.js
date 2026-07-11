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
// through the converter, while the top-level dependency is the newer rendering
// mermaid. If a bump to either is attempted, this test forces a deliberate
// re-probe of native conversion before it lands.
//
// Crucially, the converter itself only declares mermaid: "^11.12.1" (a CARET
// range), so nothing in its own manifest guarantees 11.12.1 - a fresh resolve or
// lock regen could satisfy the caret with a newer, silently-degraded 11.x. The
// exact 11.12.1 is guaranteed by a SCOPED pnpm override in pnpm-workspace.yaml
// (pnpm v11 reads overrides from the workspace file, not package.json's "pnpm"
// field). The tests below guard that override so the guarantee can't erode to
// "whatever the current tree happens to resolve": the override must stay scoped
// to the converter's nested mermaid and equal exactly 11.12.1, and must never
// become a blanket bare-`mermaid` override that would also collapse the
// top-level 11.15.0.

const WHITEBOARD_MERMAID_OVERRIDE_KEY = "@excalidraw/mermaid-to-excalidraw>mermaid";

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

function readText(relUrl) {
  return readFileSync(new URL(relUrl, import.meta.url), "utf8");
}

// Extract an `overrides:` entry's value from a YAML-ish file (pnpm-workspace.yaml
// or pnpm-lock.yaml) without pulling in a YAML parser. The key may be quoted; the
// value may be quoted or bare. Returns the raw value string, or undefined.
function readOverrideValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*["']?${escaped}["']?\\s*:\\s*["']?([^"'\\s]+)["']?\\s*$`, "m");
  const match = text.match(re);
  return match ? match[1] : undefined;
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

test("a scoped pnpm override guarantees the whiteboard mermaid, not the resolved tree", () => {
  // This guards the GUARANTEE, not just what is currently installed: the
  // converter declares only mermaid: "^11.12.1", so without this scoped override
  // a fresh `pnpm install` / lock regen could satisfy the caret with a newer
  // 11.x and silently break conversion. Assert the override exists, is scoped to
  // the converter's nested mermaid, and pins EXACTLY 11.12.1.
  const workspace = readText("../pnpm-workspace.yaml");
  const overrideValue = readOverrideValue(workspace, WHITEBOARD_MERMAID_OVERRIDE_KEY);
  assert.equal(
    overrideValue,
    WHITEBOARD_MERMAID_PIN,
    `pnpm-workspace.yaml must pin ${WHITEBOARD_MERMAID_OVERRIDE_KEY} to exactly ${WHITEBOARD_MERMAID_PIN} ` +
      `(pnpm v11 reads overrides here, not from package.json). A bump/removal must re-probe native conversion first.`,
  );

  // A blanket bare-`mermaid` override would wrongly collapse the top-level
  // rendering mermaid (11.15.0) onto 11.12.1 too. It must stay scoped.
  assert.equal(
    readOverrideValue(workspace, "mermaid"),
    undefined,
    "the mermaid override must stay scoped to the converter, never a blanket bare-`mermaid` override",
  );

  // The regenerated lockfile must record the same scoped override, so the pin is
  // reproducible from the committed lockfile and not just the working tree.
  const lock = readText("../pnpm-lock.yaml");
  assert.equal(
    readOverrideValue(lock, WHITEBOARD_MERMAID_OVERRIDE_KEY),
    WHITEBOARD_MERMAID_PIN,
    `pnpm-lock.yaml must record the scoped mermaid override at ${WHITEBOARD_MERMAID_PIN}; run \`pnpm install --lockfile-only\``,
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
