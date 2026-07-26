// Empirical repro for layout-warning identity, run against a real browser.
//
// Serves an artifact page carrying the real serialized SDK from `createSdkJs` and
// the real bundled Mermaid, loads it in real headless Chromium, and captures the
// exact `lavish:layoutWarnings` payload the SDK posts. At top level
// `parent === window`, so the page can listen for its own postMessage - no
// devtools protocol and no test double anywhere in the measured path.
//
//   node task-evidence/selector-identity/repro.js [--runs N] [--width N]
//   LAVISH_CHROME=/path/to/chrome node task-evidence/selector-identity/repro.js
//
// The page contains two pairs of structurally identical subtrees, each nested
// deeply enough that the display selector's segment cap discards the only
// segment that told them apart:
//
//   html > body > div:nth-of-type(N) > div > div > div > div > pre
//                 ^^^^^^^^^^^^^^^^^^ the distinguishing segment
//   ------------------------- capped display selector keeps only ---------
//                             div > div > div > div > pre
//
// It also holds two live Mermaid diagrams whose <foreignObject> label content
// really overflows, which is where Mermaid's regenerated node ids surface.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHROME =
  process.env.LAVISH_CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`;

const { createSdkJs } = await import(`${REPO}/src/server.js`);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const RUNS = Number(flag("runs", 2));
const WIDTH = Number(flag("width", 520));

const OVERFLOW_A = "ingest-raw-telemetry-from-every-edge-collector-and-normalize-the-event-envelopes-before-fanout";
const OVERFLOW_B = "authenticate-the-operator-against-the-identity-provider-then-authorize-the-control-plane-scope";

const htmlSubtree = (text) => `<div class="wrap"><div class="a"><div class="b"><div class="c"><div class="d">
<pre class="code">${text}</pre>
</div></div></div></div></div>`;

// `data-lavish-mermaid` is the documented opt-in wrapper. Unlike `.mermaid` it is
// not replaced by a whiteboard iframe, so the diagram stays live and its
// <foreignObject> label content is really audited.
const DIAGRAM_A = `flowchart LR
  A[Ingest raw telemetry from every edge collector] --> B[Normalize and de-duplicate event envelopes]`;

const DIAGRAM_B = `flowchart LR
  P[Authenticate the operator against the identity provider] --> Q[Authorize the control-plane scope]`;

const mermaidSubtree = (id) => `<div class="wrap"><div class="a"><div class="b"><div class="c"><div class="d">
<div class="diagram" data-lavish-mermaid id="${id}"></div>
</div></div></div></div></div>`;

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>selector identity repro</title>
<style>
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; }
  .wrap, .a, .b, .c, .d { display: block; }
  pre.code { margin: 8px; font-size: 13px; }
</style>
</head>
<body>
${htmlSubtree(OVERFLOW_A)}
${htmlSubtree(OVERFLOW_B)}
${mermaidSubtree("slotA")}
${mermaidSubtree("slotB")}
<script type="module">
  import mermaid from "/design/mermaid.esm.min.mjs";
  // Mermaid's own id scheme: "mermaid-" + a per-render timestamp. Every
  // descendant node group id is derived from it, which is what makes
  // g#mermaid-<ts>-flowchart-P-0 a different string on every single load.
  mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });
  for (const [slot, src] of [["slotA", ${JSON.stringify(DIAGRAM_A)}], ["slotB", ${JSON.stringify(DIAGRAM_B)}]]) {
    const { svg } = await mermaid.render("mermaid-" + Date.now() + "-" + slot, src);
    document.getElementById(slot).innerHTML = svg;
  }
  // Widen the label boxes only AFTER Mermaid has measured and sized its
  // <foreignObject> slots - the late-webfont failure mode. Label content ends up
  // wider than the slot Mermaid reserved, so the audit sees a real overflow on a
  // diagram DESCENDANT, which is where the volatile node ids appear.
  const late = document.createElement("style");
  late.textContent = "foreignObject > div { width: 320px !important; max-width: none !important; }";
  document.head.appendChild(late);
</script>
<script src="/sdk.js"></script>
<script>
  // The SDK's first audit fires ~50ms after init, long before Mermaid renders,
  // so nudge it once rendering has settled and report the last audit.
  const reports = [];
  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "lavish:layoutWarnings") reports.push(event.data.layout_warnings);
  });
  for (const delay of [5000, 8000]) setTimeout(() => window.dispatchEvent(new Event("resize")), delay);
  setTimeout(() => {
    fetch("/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reports,
        svgIds: [...document.querySelectorAll("svg")].map((svg) => svg.id),
      }),
    });
  }, 12000);
</script>
</body>
</html>`;

const sdkJs = createSdkJs("evidence");
const MIME = { ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css" };

let resolveResult = () => {};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, type, body) => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };

  if (req.method === "POST" && url.pathname === "/result") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    resolveResult(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return send(200, "text/plain", "ok");
  }
  if (url.pathname === "/" || url.pathname === "/index.html") return send(200, "text/html", PAGE);
  if (url.pathname === "/sdk.js") return send(200, "text/javascript", sdkJs);
  if (url.pathname.startsWith("/design/")) {
    const file = path.join(REPO, "dist", url.pathname.slice(1));
    try {
      return send(200, MIME[path.extname(file)] || "application/octet-stream", await readFile(file));
    } catch {
      return send(404, "text/plain", "not found");
    }
  }
  return send(404, "text/plain", "not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = /** @type {{ port: number }} */ (server.address()).port;

async function runOnce(index) {
  const profile = await mkdtemp(path.join(tmpdir(), "lavish-evidence-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--disable-extensions",
      `--user-data-dir=${profile}`,
      `--window-size=${WIDTH},900`,
      "--force-device-scale-factor=1",
      `http://127.0.0.1:${port}/index.html`,
    ],
    { stdio: "ignore" },
  );

  const reported = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const result = await Promise.race([
    reported,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 40000)),
  ]);
  chrome.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  return { run: index, ...result };
}

const runs = [];
for (let index = 0; index < RUNS; index += 1) runs.push(await runOnce(index));
server.close();

// Exactly how `layoutWarningKey` in src/session-store.js spells it.
const keyOf = (warning) => `${warning.kind}:${warning.identity || warning.selector}`;

for (const run of runs) {
  const findings = run.reports?.at(-1) || [];
  console.log(`\n=== run ${run.run}${run.timedOut ? " (TIMED OUT)" : ""}`);
  console.log(`svg ids: ${(run.svgIds || []).join(", ")}`);
  console.log(`findings: ${findings.length}   distinct keys: ${new Set(findings.map(keyOf)).size}`);
  for (const finding of findings) {
    console.log(`  ${keyOf(finding)}`);
    if (finding.identity && finding.identity !== finding.selector) {
      console.log(`      display selector: ${finding.selector}`);
    }
  }
}

const keySets = runs.map((run) => new Set((run.reports?.at(-1) || []).map(keyOf)));
const [first, ...rest] = keySets;
const stable = rest.every((set) => set.size === first.size && [...set].every((key) => first.has(key)));
console.log(`\nidentity stable across ${runs.length} independent page loads: ${stable ? "YES" : "NO"}`);
for (const [index, set] of keySets.entries()) {
  const minted = [...set].filter((key) => !first.has(key));
  if (index > 0 && minted.length) console.log(`  run ${index} minted new keys:\n    ${minted.join("\n    ")}`);
}
