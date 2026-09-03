import assert from "node:assert/strict";
import test from "node:test";

import {
  calculatePinchGesture,
  classifyHorizontalOverflow,
  classifyScaledDownSvg,
  classifyVerticalOverflow,
  createArtifactSdk,
  createTwoPointerTracker,
  deriveLavishQueueKey,
  fragmentsSignificantlyOverlap,
  installReadAloudButtons,
  isModeToggleHotkeyEvent,
  isNativeInteractiveControl,
  isSvgLayoutDescendant,
  resolveVisibleSpillCandidates,
  scaledDownDiagramSeverity,
} from "../src/artifact-sdk.js";

test("calculatePinchGesture reports two-finger pan centers and zoom factor", () => {
  assert.deepEqual(
    calculatePinchGesture({
      previous: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
      current: { a: { x: 10, y: 20 }, b: { x: 210, y: 20 } },
    }),
    {
      factor: 0.5,
      previousCenter: { x: 50, y: 0 },
      currentCenter: { x: 110, y: 20 },
    },
  );
});

test("classifyScaledDownSvg flags a diagram rendered below 75% of its intrinsic width", () => {
  assert.deepEqual(classifyScaledDownSvg({ renderedWidth: 390, intrinsicMaxWidth: 900 }), {
    scale: 390 / 900,
    shrinkPx: 510,
  });
});

test("classifyScaledDownSvg ignores a normally-sized diagram", () => {
  assert.equal(classifyScaledDownSvg({ renderedWidth: 780, intrinsicMaxWidth: 900 }), null);
  assert.equal(classifyScaledDownSvg({ renderedWidth: 900, intrinsicMaxWidth: 900 }), null);
});

test("scaled-down diagrams block below 60% and warn below 75%", () => {
  assert.equal(scaledDownDiagramSeverity(0.4), "error");
  assert.equal(scaledDownDiagramSeverity(0.59), "error");
  assert.equal(scaledDownDiagramSeverity(0.6), "warning");
  assert.equal(scaledDownDiagramSeverity(0.74), "warning");
});

test("two-pointer tracker ignores a third finger and cleans up cancel or lost capture", () => {
  const pointers = createTwoPointerTracker();
  assert.equal(pointers.add(1, { x: 0, y: 0 }), true);
  assert.equal(pointers.add(2, { x: 10, y: 0 }), true);
  assert.equal(pointers.add(3, { x: 20, y: 0 }), false);
  assert.deepEqual(pointers.pair(), { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });

  assert.equal(pointers.delete(1), true); // pointercancel
  assert.equal(pointers.pair(), null);
  assert.equal(pointers.add(3, { x: 20, y: 0 }), true);
  assert.deepEqual(pointers.pair(), { a: { x: 10, y: 0 }, b: { x: 20, y: 0 } });
  assert.equal(pointers.delete(2), true); // lostpointercapture
  assert.equal(pointers.size, 1);
});

test("Mermaid enhancement snapshots geometry before whiteboard hiding and the layout audit reports it", () => {
  const saved = Object.fromEntries(
    ["window", "document", "parent", "Element", "CSS", "getComputedStyle"].map((key) => [key, globalThis[key]]),
  );
  const rect = (width, height) => ({ left: 0, top: 0, right: width, bottom: height, width, height });
  const styleDefaults = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    overflowX: "visible",
    overflowY: "visible",
    position: "static",
    maxWidth: "100%",
    borderLeftWidth: "0px",
    borderRightWidth: "0px",
    borderTopWidth: "0px",
    borderBottomWidth: "0px",
    paddingLeft: "0px",
    paddingRight: "0px",
    paddingTop: "0px",
    paddingBottom: "0px",
  };
  const setGlobal = (key, value) => {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  let iframeWidth = 500;
  let shortDiagramHeight = 22;

  try {
    setGlobal(
      "Element",
      class {
        static [Symbol.hasInstance](value) {
          return value?.nodeType === 1;
        }
      },
    );
    setGlobal("CSS", { escape: (value) => String(value) });
    const body = node("body");
    const container = append(body, node("pre", { class: "mermaid" }));
    container.className = "mermaid";
    container.style = {};
    container.getBoundingClientRect = () => rect(500, container.style.display === "none" ? 0 : 80);
    container.getClientRects = () => [];
    container.insertAdjacentElement = (_position, child) => append(body, child);
    const svg = append(container, node("svg", { id: "mermaid-wide", viewBox: "0 0 1223 80", width: "100%" }));
    svg.style = {};
    svg.getBoundingClientRect = () => (container.style.display === "none" ? rect(0, 0) : rect(500, 80));
    svg.getClientRects = () => [];
    svg.getBBox = () => ({ x: 0, y: 0, width: 1223, height: 80 });
    svg.setAttribute = (name, value) => {
      attrsFor(svg)[name] = String(value);
      if (name === "id") svg.id = String(value);
    };
    const listeners = new Map();
    const captures = [];
    svg.addEventListener = (type, listener) => listeners.set(type, listener);
    svg.setPointerCapture = (id) => captures.push(id);
    svg.releasePointerCapture = () => {};
    svg.scrollWidth = svg.clientWidth = 500;
    svg.scrollHeight = svg.clientHeight = 80;

    const scroller = append(body, node("div"));
    scroller.style = { overflowX: "auto" };
    scroller.getBoundingClientRect = () => rect(390, 40);
    scroller.getClientRects = () => [];
    scroller.scrollWidth = scroller.clientWidth = 390;
    scroller.scrollHeight = scroller.clientHeight = 40;
    const shortContainer = append(scroller, node("pre", { class: "mermaid" }));
    shortContainer.className = "mermaid";
    shortContainer.style = {};
    shortContainer.getBoundingClientRect = () =>
      rect(390, shortContainer.style.display === "none" ? 0 : shortDiagramHeight);
    shortContainer.getClientRects = () => [];
    shortContainer.insertAdjacentElement = (_position, child) => append(scroller, child);
    shortContainer.scrollWidth = shortContainer.clientWidth = 390;
    shortContainer.scrollHeight = shortContainer.clientHeight = 22;
    const shortSvg = append(
      shortContainer,
      node("svg", { id: "mermaid-short", viewBox: "0 0 1223 80", width: "100%" }),
    );
    shortSvg.style = {};
    shortSvg.getBoundingClientRect = () =>
      shortContainer.style.display === "none" ? rect(0, 0) : rect(390, shortDiagramHeight);
    shortSvg.getClientRects = () => [];
    shortSvg.getBBox = () => ({ x: 0, y: 0, width: 1223, height: 80 });
    shortSvg.setAttribute = (name, value) => {
      attrsFor(shortSvg)[name] = String(value);
    };
    shortSvg.addEventListener = () => {};
    shortSvg.setPointerCapture = () => {};
    shortSvg.releasePointerCapture = () => {};
    shortSvg.scrollWidth = shortSvg.clientWidth = 390;
    shortSvg.scrollHeight = shortSvg.clientHeight = 22;

    const sketchScript = node("script");
    sketchScript.textContent = '{"elements":[{"id":"m1","type":"rectangle","x":0,"y":0,"width":120,"height":60}]}';
    // Distinct tags keep the audit's nth-of-type selector expectations for the
    // pre-existing div scroller untouched.
    const sketchContainer = append(body, node("section", { class: "lavish-sketch" }));
    sketchContainer.className = "lavish-sketch";
    sketchContainer.style = {};
    sketchContainer.querySelector = (sel) =>
      sel === 'script[type="application/lavish-sketch+json"]' ? sketchScript : null;
    sketchContainer.insertAdjacentElement = (_position, child) => append(body, child);
    sketchContainer.getBoundingClientRect = () => rect(500, 120);
    sketchContainer.getClientRects = () => [];
    sketchContainer.scrollWidth = sketchContainer.clientWidth = 500;
    sketchContainer.scrollHeight = sketchContainer.clientHeight = 120;

    const emptySketch = append(body, node("aside", { class: "lavish-sketch" }));
    emptySketch.className = "lavish-sketch";
    emptySketch.style = {};
    emptySketch.querySelector = () => null;
    emptySketch.getBoundingClientRect = () => rect(500, 30);
    emptySketch.getClientRects = () => [];
    emptySketch.scrollWidth = emptySketch.clientWidth = 500;
    emptySketch.scrollHeight = emptySketch.clientHeight = 30;

    const documentElement = node("html", {}, [body]);
    documentElement.style = {};
    documentElement.scrollWidth = 500;
    documentElement.clientWidth = 500;
    documentElement.appendChild = (child) => append(documentElement, child);
    for (const el of [body, container, documentElement]) {
      el.getBoundingClientRect ||= () => rect(500, 100);
      el.getClientRects ||= () => [];
      el.scrollWidth ||= 500;
      el.clientWidth ||= 500;
      el.scrollHeight ||= 100;
      el.clientHeight ||= 100;
    }

    setGlobal("window", {
      innerWidth: 500,
      innerHeight: 800,
      addEventListener() {},
      setTimeout() {},
      requestAnimationFrame() {},
    });
    setGlobal("parent", { postMessage() {} });
    setGlobal("document", {
      body,
      documentElement,
      querySelectorAll(selector) {
        if (selector === "svg") return [svg, shortSvg];
        if (selector === ".mermaid") return [container, shortContainer];
        if (selector === ".lavish-sketch") return [sketchContainer, emptySketch];
        if (selector === ".mermaid, .lavish-sketch") return [container, shortContainer, sketchContainer, emptySketch];
        return [];
      },
      createElement(tag) {
        const el = node(tag);
        el.style = {};
        el.isConnected = true;
        el.setAttribute = (name, value) => {
          attrsFor(el)[name] = String(value);
        };
        el.getBoundingClientRect = () => rect(iframeWidth, 456);
        el.remove = () => {
          el.isConnected = false;
          const siblings = el.parentElement?.children;
          if (siblings) siblings.splice(siblings.indexOf(el), 1);
        };
        return el;
      },
      elementFromPoint() {
        return null;
      },
    });
    setGlobal("getComputedStyle", (el) => ({
      ...styleDefaults,
      .../** @type {any} */ (el.style || {}),
    }));

    const hooks = {};
    createArtifactSdk(() => "", undefined, undefined, hooks);
    hooks.enhanceMermaid();
    const embeddedIframe = body.children.find((child) => child.tagName === "IFRAME");
    assert.match(embeddedIframe.style.cssText, /box-sizing:border-box/);
    assert.match(embeddedIframe.style.cssText, /display:none/);
    assert.notEqual(container.style.display, "none", "the diagram stays visible until the whiteboard confirms boot");
    hooks.handleWhiteboardControl({ type: "lavish:whiteboardActive", diagramIndex: 0 });
    assert.equal(container.style.display, "none");
    assert.equal(embeddedIframe.style.display, "block");
    assert.equal(shortContainer.style.display, undefined, "a short live diagram is not whiteboard-embedded");

    const sketchIframe = body.children.find(
      (child) => child.tagName === "IFRAME" && String(child.src || "").includes("diagramIndex=2"),
    );
    assert.ok(sketchIframe, "a sketch container boots a hidden whiteboard frame under the unified index");
    assert.match(sketchIframe.style.cssText, /display:none/);
    assert.match(sketchIframe.style.cssText, /height:360px/);
    assert.notEqual(
      sketchContainer.style.display,
      "none",
      "sketch fallback stays visible until the editor confirms boot",
    );
    assert.equal(
      body.children.some((child) => child.tagName === "IFRAME" && String(child.src || "").includes("diagramIndex=3")),
      false,
      "a sketch container without scene JSON is not embedded",
    );
    hooks.handleWhiteboardControl({ type: "lavish:whiteboardActive", diagramIndex: 2 });
    assert.equal(sketchContainer.style.display, "none");
    assert.equal(sketchIframe.style.display, "block");
    assert.equal(svg.style.touchAction, "pan-y");
    hooks.setMermaidFrozen(false);
    assert.equal(svg.style.touchAction, "none");
    hooks.setMermaidFrozen(true);
    assert.equal(svg.style.touchAction, "pan-y");
    listeners.get("pointerdown")({ button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    assert.deepEqual(captures, [], "a frozen one-finger annotation pointer is not captured or click-retargeted");
    listeners.get("pointerdown")({ button: 0, pointerId: 2, clientX: 20, clientY: 10 });
    assert.deepEqual(captures, [1, 2], "capture starts only once a two-finger diagram gesture exists");
    listeners.get("pointerdown")({ button: 0, pointerId: 3, clientX: 30, clientY: 10 });
    assert.deepEqual(captures, [1, 2], "a third finger is ignored");
    listeners.get("pointercancel")({ pointerId: 1 });
    listeners.get("lostpointercapture")({ pointerId: 2 });
    shortSvg.setAttribute("viewBox", "0 0 2446 160"); // pan/zoom must not change the intrinsic audit width
    const initialFindings = hooks.auditLayout();
    assert.equal(initialFindings.length, 2, "embedded and live diagrams emit exactly one shrink finding each");
    assert.deepEqual(
      initialFindings.find((finding) => finding.selector === "html > body > pre"),
      {
        selector: "html > body > pre",
        kind: "scaled-down-diagram",
        overflowPx: 723,
        viewportWidth: 500,
        severity: "error",
      },
    );
    const liveFinding = initialFindings.find((finding) => finding.selector === "html > body > div > pre");
    assert.deepEqual(liveFinding, {
      selector: "html > body > div > pre",
      kind: "scaled-down-diagram",
      overflowPx: 833,
      viewportWidth: 500,
      severity: "error",
    });
    shortSvg.id = "mermaid-regenerated-at-a-different-time";
    assert.equal(
      hooks.auditLayout().find((finding) => finding.kind === "scaled-down-diagram" && finding.selector.includes("div"))
        .selector,
      liveFinding.selector,
      "a Mermaid re-render that changes the generated SVG id keeps the same warning identity",
    );

    shortDiagramHeight = 80;
    hooks.enhanceMermaid();
    hooks.handleWhiteboardControl({ type: "lavish:whiteboardActive", diagramIndex: 1 });
    assert.equal(shortContainer.style.display, "none");
    assert.equal(
      hooks.auditLayout().find((finding) => finding.kind === "scaled-down-diagram" && finding.selector.includes("div"))
        .selector,
      liveFinding.selector,
      "live and whiteboard-embedded paths use the same Mermaid container identity",
    );

    iframeWidth = 800;
    globalThis.window.innerWidth = 800;
    documentElement.scrollWidth = documentElement.clientWidth = 800;
    assert.deepEqual(
      hooks.auditLayout().find((finding) => finding.selector === "html > body > pre"),
      {
        selector: "html > body > pre",
        kind: "scaled-down-diagram",
        overflowPx: 423,
        viewportWidth: 800,
        severity: "warning",
      },
      "embedded audits use the iframe's current width after a resize",
    );

    const scrollerIframe = scroller.children.find((child) => child.tagName === "IFRAME");
    hooks.handleWhiteboardControl({ type: "lavish:whiteboardUnavailable", diagramIndex: 1 });
    assert.equal(scroller.children.includes(scrollerIframe), false, "a failed whiteboard's frame is removed");
    assert.equal(shortContainer.style.display, "", "the plain diagram is restored when the whiteboard fails");
    hooks.enhanceMermaid();
    assert.equal(
      scroller.children.some((child) => child.tagName === "IFRAME"),
      false,
      "a failed container is not re-embedded into a retry loop",
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else setGlobal(key, value);
    }
  }
});

/**
 * Build one fake element carrying the geometry the layout audit actually reads.
 * `overflowBy` makes it genuinely overflow its own scroll box, which is what
 * `classifyHorizontalOverflow` flags - so a finding here is produced by the real
 * audit path rather than injected.
 *
 * @param {string} tag
 * @param {{ attrs?: Record<string, string>, width?: number, height?: number, overflowBy?: number,
 *   style?: Record<string, string>, ownerSVGElement?: unknown }} [options]
 */
function auditNode(tag, { attrs = {}, width = 400, height = 40, overflowBy = 0, style = {}, ownerSVGElement } = {}) {
  const el = node(tag, attrs);
  el.style = { ...style };
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height });
  el.getClientRects = () => [];
  el.clientWidth = width;
  el.scrollWidth = width + overflowBy;
  el.clientHeight = height;
  el.scrollHeight = height;
  // Real SVG children report an ownerSVGElement, which is how the audit knows to
  // skip SVG internals while still descending into <foreignObject> HTML.
  if (ownerSVGElement !== undefined) el.ownerSVGElement = ownerSVGElement;
  return el;
}

// Chain elements parent -> child and return the innermost one.
function auditChain(root, elements) {
  let parent = root;
  for (const el of elements) parent = append(parent, el);
  return parent;
}

// Stand up the minimum browser surface `auditLayout` touches, run `build` to
// populate <body>, then hand the real audit closure to `run`.
function withLayoutAudit(build, run) {
  const saved = Object.fromEntries(
    ["window", "document", "parent", "Element", "CSS", "getComputedStyle"].map((key) => [key, globalThis[key]]),
  );
  const setGlobal = (key, value) => {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const styleDefaults = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    overflowX: "visible",
    overflowY: "visible",
    position: "static",
    maxWidth: "100%",
    borderLeftWidth: "0px",
    borderRightWidth: "0px",
    borderTopWidth: "0px",
    borderBottomWidth: "0px",
    paddingLeft: "0px",
    paddingRight: "0px",
    paddingTop: "0px",
    paddingBottom: "0px",
  };

  try {
    setGlobal(
      "Element",
      class {
        static [Symbol.hasInstance](value) {
          return value?.nodeType === 1;
        }
      },
    );
    setGlobal("CSS", { escape: (value) => String(value) });

    const body = auditNode("body", { width: 400, height: 400 });
    const documentElement = auditNode("html", { width: 400, height: 400 });
    append(documentElement, body);
    documentElement.scrollWidth = 400;
    documentElement.clientWidth = 400;

    const fixture = build(body) || {};

    setGlobal("window", {
      innerWidth: 400,
      innerHeight: 800,
      addEventListener() {},
      setTimeout() {},
      requestAnimationFrame() {},
    });
    setGlobal("parent", { postMessage() {} });
    setGlobal("document", {
      body,
      documentElement,
      querySelectorAll: () => [],
      createElement: (tag) => auditNode(tag),
      elementFromPoint: () => null,
    });
    setGlobal("getComputedStyle", (el) => ({ ...styleDefaults, .../** @type {any} */ (el.style || {}) }));

    const hooks = {};
    createArtifactSdk(() => "", undefined, undefined, hooks);
    run({ hooks, body, documentElement, ...fixture });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else setGlobal(key, value);
    }
  }
}

// Two structurally identical subtrees, deep enough that the display selector's
// segment cap throws away the only thing that told them apart. Before findings
// carried an identity separate from the display selector, both <pre> elements
// keyed as `div > div > div > div > pre` and the second one was silently
// dropped by dedupe - the log lost a real, distinct problem.
test("two identical subtrees past the selector display cap stay two findings", () => {
  withLayoutAudit(
    (body) => {
      const wrappers = [1, 2].map(() => {
        const wrapper = auditNode("div");
        append(body, wrapper);
        return auditChain(wrapper, [auditNode("div"), auditNode("div"), auditNode("div"), auditNode("div")]);
      });
      const first = append(wrappers[0], auditNode("pre", { overflowBy: 120 }));
      const second = append(wrappers[1], auditNode("pre", { overflowBy: 240 }));
      return { first, second };
    },
    ({ hooks }) => {
      const findings = hooks.auditLayout().filter((finding) => finding.kind === "element-scroll-overflow");

      assert.equal(findings.length, 2, "both broken <pre> elements survive dedupe");
      assert.deepEqual(
        findings.map((finding) => finding.selector),
        ["div > div > div > div > pre", "div > div > div > div > pre"],
        "the display selector is still capped, and is deliberately ambiguous here",
      );
      assert.deepEqual(
        findings.map((finding) => finding.identity),
        [
          "html > body > div:nth-of-type(1) > div > div > div > div > pre",
          "html > body > div:nth-of-type(2) > div > div > div > div > pre",
        ],
        "identity keeps the full path, including the nth-of-type the cap discarded",
      );
      assert.deepEqual(
        findings.map((finding) => finding.overflowPx),
        [120, 240],
        "each finding reports its own element's overflow, not the first one's",
      );
    },
  );
});

// The old harness had one <pre> per parent, so `:nth-of-type` was never
// exercised at all. It is the only thing separating same-tag siblings.
test("same-tag siblings are separated by :nth-of-type", () => {
  withLayoutAudit(
    (body) => {
      const section = append(body, auditNode("section"));
      // Interleaved <p> elements: :nth-of-type counts same-tag siblings only, so
      // these <pre> elements are 1 and 2 - not the 2 and 4 :nth-child would give.
      append(section, auditNode("p"));
      append(section, auditNode("pre", { overflowBy: 30 }));
      append(section, auditNode("p"));
      append(section, auditNode("pre", { overflowBy: 60 }));
    },
    ({ hooks }) => {
      const findings = hooks.auditLayout().filter((finding) => finding.kind === "element-scroll-overflow");

      assert.deepEqual(
        findings.map((finding) => finding.selector),
        ["html > body > section > pre:nth-of-type(1)", "html > body > section > pre:nth-of-type(2)"],
      );
      assert.deepEqual(
        findings.map((finding) => finding.identity),
        [undefined, undefined],
        "a path that fits the cap carries no separate identity, so its key is unchanged",
      );
    },
  );
});

// Mermaid derives every descendant id from the svg root id it regenerates on
// each render, so `g#mermaid-<ms>-flowchart-P-0` is a new string after every
// reload or theme re-render. Identity anchored on it never latches: `persistent`
// never fires and the durable log fills with duplicates of one problem.
test("Mermaid descendant identity survives a regenerated svg id", () => {
  withLayoutAudit(
    (body) => {
      const container = append(body, auditNode("div", { attrs: { "data-lavish-mermaid": "" } }));
      const svg = append(container, auditNode("svg", { attrs: { id: "mermaid-1785021297984" } }));
      const svgChild = (tag, attrs = {}) => auditNode(tag, { attrs, ownerSVGElement: svg });
      const nodes = append(svg, svgChild("g"));
      const nodeLayer = append(nodes, svgChild("g"));

      const labels = ["P-0", "Q-1"].map((suffix, index) => {
        const group = append(nodeLayer, svgChild("g", { id: `mermaid-1785021297984-flowchart-${suffix}` }));
        const inner = append(group, svgChild("g"));
        const foreignObject = append(inner, svgChild("foreignObject"));
        // <foreignObject> re-enters HTML, so its content has no ownerSVGElement
        // and is really audited - this is where the reported findings landed.
        return append(foreignObject, auditNode("div", { overflowBy: 40 * (index + 1) }));
      });
      return { svg, labels };
    },
    ({ hooks, svg }) => {
      // The key the log and the persistent flag actually dedupe on, spelled out
      // the same way `layoutWarningKey` spells it.
      const keys = () =>
        hooks
          .auditLayout()
          .filter((finding) => finding.kind === "element-scroll-overflow")
          .map((finding) => `${finding.kind}:${finding.identity || finding.selector}`);

      const before = keys();
      assert.deepEqual(
        before.filter((key) => key.includes("mermaid-")),
        [],
        "no generated Mermaid id appears anywhere in a diagram descendant's key",
      );
      assert.deepEqual(
        before,
        [
          "element-scroll-overflow:html > body > div > svg > g > g > g:nth-of-type(1) > g > foreignobject > div",
          "element-scroll-overflow:html > body > div > svg > g > g > g:nth-of-type(2) > g > foreignobject > div",
        ],
        "dropping the volatile ids still leaves the two labels distinguishable by position",
      );

      svg.id = "mermaid-1785099999999";
      assert.deepEqual(keys(), before, "a re-render that regenerates the svg id keeps descendant identity");
    },
  );
});

test("the display selector never anchors to a minted Mermaid id", () => {
  withLayoutAudit(
    (body) => {
      const container = append(body, auditNode("div", { attrs: { "data-lavish-mermaid": "" } }));
      const svg = append(container, auditNode("svg", { attrs: { id: "mermaid-1785021297984" } }));
      const svgChild = (tag, attrs = {}) => auditNode(tag, { attrs, ownerSVGElement: svg });
      const nodes = append(svg, svgChild("g"));
      const nodeLayer = append(nodes, svgChild("g"));
      for (const [index, suffix] of ["P-0", "Q-1"].entries()) {
        const group = append(nodeLayer, svgChild("g", { id: `mermaid-1785021297984-flowchart-${suffix}` }));
        const inner = append(group, svgChild("g"));
        const foreignObject = append(inner, svgChild("foreignObject"));
        append(foreignObject, auditNode("div", { overflowBy: 40 * (index + 1) }));
      }
      return { svg };
    },
    ({ hooks, svg }) => {
      const selectors = () =>
        hooks
          .auditLayout()
          .filter((finding) => finding.kind === "element-scroll-overflow")
          .map((finding) => finding.selector);

      const before = selectors();
      assert.deepEqual(
        before,
        ["g > g:nth-of-type(1) > g > foreignobject > div", "g > g:nth-of-type(2) > g > foreignobject > div"],
        "inside a Mermaid svg the display anchors to structure, never to an id that changes each render",
      );

      svg.id = "mermaid-1785099999999";
      assert.deepEqual(selectors(), before, "regenerating the svg id leaves the display selector untouched");
    },
  );
});

test("a stable id outside Mermaid still anchors the display selector", () => {
  withLayoutAudit(
    (body) => {
      const app = append(body, auditNode("div", { attrs: { id: "app" } }));
      const section = append(app, auditNode("section"));
      append(section, auditNode("div", { overflowBy: 24 }));
      return {};
    },
    ({ hooks }) => {
      const selectors = hooks
        .auditLayout()
        .filter((finding) => finding.kind === "element-scroll-overflow")
        .map((finding) => finding.selector);
      assert.deepEqual(selectors, ["div#app > section > div"], "author-written ids keep the display short");
    },
  );
});

function node(tag, attrs = {}, children = []) {
  const el = {
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? attrs[name] : null;
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (matchesSelectorList(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    matches(selector) {
      return matchesSelectorList(this, selector);
    },
    contains(other) {
      let current = other;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
  };
  if (attrs.id) el.id = attrs.id;
  if (attrs.name) el.name = attrs.name;
  if (attrs.type) el.type = attrs.type;
  if (attrs.value) el.value = attrs.value;
  for (const child of children) append(el, child);
  return el;
}

function attrsFor(el) {
  // The small fake DOM intentionally keeps attributes behind getAttribute.
  // Install a mutable overlay only for integration-test nodes that need writes.
  if (!el.__testAttrs) {
    el.__testAttrs = {};
    const original = el.getAttribute.bind(el);
    el.getAttribute = (name) => (Object.hasOwn(el.__testAttrs, name) ? el.__testAttrs[name] : original(name));
  }
  return el.__testAttrs;
}

function append(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function matchesSelectorList(el, selectorList) {
  return selectorList.split(",").some((selector) => matchesSelector(el, selector.trim()));
}

function matchesSelector(el, selector) {
  if (selector === ".mermaid")
    return String(el.className || "")
      .split(/\s+/)
      .includes("mermaid");
  if (selector === ".mermaid, [data-lavish-mermaid]") {
    return matchesSelector(el, ".mermaid") || el.getAttribute("data-lavish-mermaid") !== null;
  }
  if (selector === "[data-lavish-ui]") return el.getAttribute("data-lavish-ui") !== null;
  if (selector === "form" || selector === "fieldset") return el.tagName.toLowerCase() === selector;
  if (selector === "[data-lavish-question]") return el.getAttribute("data-lavish-question") !== null;
  if (selector === "[contenteditable]:not([contenteditable='false'])") {
    const value = el.getAttribute("contenteditable");
    return value !== null && value !== "false";
  }
  if (/^[a-z]+$/i.test(selector)) return el.tagName.toLowerCase() === selector.toLowerCase();
  return false;
}

test("isNativeInteractiveControl leaves details body descendants annotatable", () => {
  const summaryChild = node("span");
  const summary = node("summary", {}, [summaryChild]);
  const bodyText = node("span");
  const bodyLink = node("a", { href: "#target" });
  const body = node("div", {}, [bodyText, bodyLink]);
  const details = node("details", { open: "" }, [summary, body]);

  assert.equal(isNativeInteractiveControl(summaryChild), true);
  assert.equal(isNativeInteractiveControl(details), false);
  assert.equal(isNativeInteractiveControl(bodyText), false);
  assert.equal(isNativeInteractiveControl(bodyLink), false);
});

test("isNativeInteractiveControl allows details as a text selection ancestor", () => {
  const firstParagraph = node("p");
  const secondParagraph = node("p");
  const details = node("details", { open: "" }, [node("summary", {}, [node("span")]), firstParagraph, secondParagraph]);

  assert.equal(isNativeInteractiveControl(details), false);
  assert.equal(isNativeInteractiveControl(firstParagraph), false);
  assert.equal(isNativeInteractiveControl(secondParagraph), false);
});

test("deriveLavishQueueKey uses explicit queueKey first", () => {
  const input = node("input", { type: "radio", name: "plan" });

  assert.equal(deriveLavishQueueKey(input, { queueKey: "deployment-plan" }), "deployment-plan");
});

test("deriveLavishQueueKey allows explicit empty queueKey to suppress derivation", () => {
  const button = node("button");
  node("section", { "data-lavish-question": "deployment-plan" }, [button]);

  assert.equal(deriveLavishQueueKey(button, { queueKey: "" }), "");
});

test("deriveLavishQueueKey groups controls inside data-lavish-question", () => {
  const first = node("button");
  const second = node("button");
  node("section", { "data-lavish-question": "deployment-plan" }, [first, second]);

  assert.equal(deriveLavishQueueKey(first), "question:deployment-plan");
  assert.equal(deriveLavishQueueKey(second), "question:deployment-plan");
});

test("deriveLavishQueueKey groups radio options by scoped group name", () => {
  const planA = node("input", { id: "plan-a", type: "radio", name: "plan", value: "A" });
  const planB = node("input", { id: "plan-b", type: "radio", name: "plan", value: "B" });
  node("form", { id: "deploy" }, [planA, planB]);

  assert.equal(deriveLavishQueueKey(planA), "radio:form:deploy:plan");
  assert.equal(deriveLavishQueueKey(planB), "radio:form:deploy:plan");
});

test("deriveLavishQueueKey keeps same radio names independent across scopes", () => {
  const first = node("input", { type: "radio", name: "plan", value: "A" });
  const second = node("input", { type: "radio", name: "plan", value: "B" });
  node("form", { id: "deploy-one" }, [first]);
  node("form", { id: "deploy-two" }, [second]);

  assert.notEqual(deriveLavishQueueKey(first), deriveLavishQueueKey(second));
});

test("deriveLavishQueueKey does not infer plain button grouping without question metadata", () => {
  const button = node("button");

  assert.equal(deriveLavishQueueKey(button), "");
});

test("deriveLavishQueueKey keys checkbox toggles per checkbox, not per group", () => {
  const first = node("input", { type: "checkbox", name: "feature", value: "search" });
  const second = node("input", { type: "checkbox", name: "feature", value: "billing" });
  node("form", { id: "features" }, [first, second]);

  assert.notEqual(deriveLavishQueueKey(first), deriveLavishQueueKey(second));
});

test("deriveLavishQueueKey does not collide checkbox default values", () => {
  const first = node("input", { id: "search", type: "checkbox", name: "feature" });
  const second = node("input", { id: "billing", type: "checkbox", name: "feature" });
  first.value = "on";
  second.value = "on";
  node("form", { id: "features" }, [first, second]);

  assert.notEqual(deriveLavishQueueKey(first), deriveLavishQueueKey(second));
});

test("deriveLavishQueueKey keys named selects as fields", () => {
  const select = node("select", { name: "region" });
  node("form", { id: "deploy" }, [select]);

  assert.equal(deriveLavishQueueKey(select), "field:form:deploy:region");
});

test("fragmentsSignificantlyOverlap ignores the reflow gap in a wrapped inline phrase's bounding box", () => {
  // A <strong> that wraps across two lines reports one getClientRects() rect per line: the end
  // of line 1 near the right edge, then the continuation at the left edge of line 2. The union
  // bounding box of those two rects spans the full width between them - a naive bounding-box
  // check would treat anything sitting in that phantom middle area as overlapping, even though
  // nothing is actually rendered there.
  const wrappedFragments = [
    { left: 620, right: 900, top: 100, bottom: 120, width: 280, height: 20 },
    { left: 0, right: 260, top: 120, bottom: 140, width: 260, height: 20 },
  ];
  const siblingInThePhantomGap = [{ left: 300, right: 600, top: 100, bottom: 120, width: 300, height: 20 }];

  assert.equal(fragmentsSignificantlyOverlap(wrappedFragments, siblingInThePhantomGap), false);
});

test("fragmentsSignificantlyOverlap flags real pixel intersection between rendered fragments", () => {
  const elFragments = [{ left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 }];
  const otherFragments = [{ left: 40, right: 140, top: 5, bottom: 25, width: 100, height: 20 }];

  assert.equal(fragmentsSignificantlyOverlap(elFragments, otherFragments), true);
});

test("fragmentsSignificantlyOverlap ignores sub-threshold seam overlap between adjacent lines", () => {
  const elFragments = [{ left: 0, right: 200, top: 0, bottom: 20, width: 200, height: 20 }];
  const barelyTouchingFragments = [{ left: 199, right: 210, top: 0, bottom: 20, width: 11, height: 20 }];

  assert.equal(fragmentsSignificantlyOverlap(elFragments, barelyTouchingFragments), false);
});

test("classifyVerticalOverflow flags a fixed-height badge whose wrapped label spills out with default overflow", () => {
  // DaisyUI-style badges/pills rarely set overflow-y at all, so it stays at its default
  // "visible" - the wrapped second word isn't clipped, it just spills outside the pill shape.
  const finding = classifyVerticalOverflow({
    scrollHeight: 40,
    clientHeight: 24,
    overflowY: "visible",
    hasText: true,
    isTruncated: false,
  });

  assert.deepEqual(finding, { overflowPx: 16, kind: "clipped-text", clips: false });
});

test("classifyVerticalOverflow marks hidden/clip overflow-y as a hard clip", () => {
  const finding = classifyVerticalOverflow({
    scrollHeight: 40,
    clientHeight: 24,
    overflowY: "hidden",
    hasText: true,
    isTruncated: false,
  });

  assert.deepEqual(finding, { overflowPx: 16, kind: "clipped-text", clips: true });
});

test("classifyVerticalOverflow ignores intentionally scrollable containers", () => {
  const finding = classifyVerticalOverflow({
    scrollHeight: 400,
    clientHeight: 200,
    overflowY: "auto",
    hasText: true,
    isTruncated: false,
  });

  assert.equal(finding, null);
});

test("classifyVerticalOverflow ignores boxes that simply grow to fit their content", () => {
  const finding = classifyVerticalOverflow({
    scrollHeight: 100,
    clientHeight: 100,
    overflowY: "visible",
    hasText: true,
    isTruncated: false,
  });

  assert.equal(finding, null);
});

test("resolveVisibleSpillCandidates keeps the deepest candidate for one bubbled spill", () => {
  const badge = node("span");
  const row = node("div", {}, [badge]);
  const section = node("section", {}, [row]);
  const candidates = [
    { el: section, selector: "section", overflowPx: 16, spillBottom: 140 },
    { el: row, selector: ".row", overflowPx: 16, spillBottom: 140 },
    { el: badge, selector: ".badge", overflowPx: 16, spillBottom: 140 },
  ];

  assert.deepEqual(
    resolveVisibleSpillCandidates(candidates).map((candidate) => candidate.selector),
    [".badge"],
  );
});

test("resolveVisibleSpillCandidates preserves ancestors with independent overflow", () => {
  const badge = node("span");
  const section = node("section", {}, [badge]);
  const candidates = [
    { el: section, selector: "section", overflowPx: 48, spillBottom: 220 },
    { el: badge, selector: ".badge", overflowPx: 16, spillBottom: 140 },
  ];

  assert.deepEqual(
    resolveVisibleSpillCandidates(candidates).map((candidate) => candidate.selector),
    ["section", ".badge"],
  );
});

test("classifyHorizontalOverflow still distinguishes clipped text from generic scroll overflow", () => {
  const clipped = classifyHorizontalOverflow({
    scrollWidth: 300,
    clientWidth: 200,
    overflowX: "hidden",
    hasText: true,
    isTruncated: false,
  });
  assert.deepEqual(clipped, { overflowPx: 100, kind: "clipped-text" });

  const genericScroll = classifyHorizontalOverflow({
    scrollWidth: 300,
    clientWidth: 200,
    overflowX: "visible",
    hasText: true,
    isTruncated: false,
  });
  assert.deepEqual(genericScroll, { overflowPx: 100, kind: "element-scroll-overflow" });
});

test("isModeToggleHotkeyEvent matches Cmd/Ctrl+I regardless of case", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "i", metaKey: true }), true);
  assert.equal(isModeToggleHotkeyEvent({ key: "I", ctrlKey: true }), true);
  assert.equal(isModeToggleHotkeyEvent({ key: "i", metaKey: true, ctrlKey: true }), true);
});

test("isModeToggleHotkeyEvent requires a modifier so plain typing is unaffected", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "i" }), false);
  assert.equal(isModeToggleHotkeyEvent({ key: "i", shiftKey: true }), false);
});

test("isModeToggleHotkeyEvent rejects extra shift or alt modifiers", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "i", ctrlKey: true, shiftKey: true }), false);
  assert.equal(isModeToggleHotkeyEvent({ key: "i", metaKey: true, altKey: true }), false);
});

test("isModeToggleHotkeyEvent ignores other keys even with a modifier held", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "e", metaKey: true }), false);
  assert.equal(isModeToggleHotkeyEvent({ key: "Enter", metaKey: true }), false);
});

// Regression: Mermaid renders labels as SVG <text>, which has no CSS scroll box and cannot clip its
// own content. Chrome still answers clientWidth/scrollWidth/scrollHeight on it with numbers derived
// from unrelated geometry (a 32px-wide "User" label reports clientWidth 257, scrollHeight 24 vs
// clientHeight 21), so auditing SVG internals reported phantom element-scroll-overflow and
// clipped-text findings at error severity on every sequence diagram - slamming the layout gate shut.
test("isSvgLayoutDescendant skips SVG internals but keeps the root <svg> and foreignObject HTML", () => {
  const svgRoot = { ownerSVGElement: null };
  const gNode = { ownerSVGElement: svgRoot };
  const svgText = { ownerSVGElement: svgRoot };
  const foreignObject = { ownerSVGElement: svgRoot };
  const htmlInsideForeignObject = {}; // HTMLElement: no ownerSVGElement property at all
  const plainDiv = {};

  // The root <svg> is a replaced element with a real CSS box, so a too-wide diagram must still flag.
  assert.equal(isSvgLayoutDescendant(svgRoot), false);
  // HTML re-entering the tree through <foreignObject> has real CSS boxes and can genuinely clip.
  assert.equal(isSvgLayoutDescendant(htmlInsideForeignObject), false);
  assert.equal(isSvgLayoutDescendant(plainDiv), false);

  assert.equal(isSvgLayoutDescendant(gNode), true);
  assert.equal(isSvgLayoutDescendant(svgText), true);
  assert.equal(isSvgLayoutDescendant(foreignObject), true);
});

test("isSvgLayoutDescendant tolerates nullish input", () => {
  assert.equal(isSvgLayoutDescendant(null), false);
  assert.equal(isSvgLayoutDescendant(undefined), false);
});

// ---------------------------------------------------------------------------
// Read-aloud block buttons
// ---------------------------------------------------------------------------

function readAloudElement(tag) {
  const listeners = new Map();
  const classes = new Set();
  const attrs = {};
  const el = {
    tagName: tag.toUpperCase(),
    style: {},
    hidden: false,
    innerHTML: "",
    children: [],
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains(name) {
        return classes.has(name);
      },
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? attrs[name] : null;
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    attachShadow() {
      el.shadow = readAloudElement("shadow");
      return el.shadow;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, event = { preventDefault() {}, stopPropagation() {} }) {
      const handler = listeners.get(type);
      assert.ok(handler, `element has a ${type} listener`);
      return handler(event);
    },
  };
  return el;
}

function readAloudMember(index, rect) {
  const el = readAloudElement("p");
  el.setAttribute("data-lavish-block", String(index));
  el.getBoundingClientRect = () => ({
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
  });
  el.scrolls = 0;
  el.scrollIntoView = () => {
    el.scrolls += 1;
  };
  return el;
}

function readAloudHarness(members) {
  const documentElement = readAloudElement("html");
  const document = {
    documentElement,
    body: {},
    querySelectorAll(selector) {
      assert.equal(selector, "[data-lavish-block]");
      return members;
    },
    createElement: (tag) => readAloudElement(tag),
  };
  const windowListeners = new Map();
  const window = {
    scrollX: 0,
    scrollY: 100,
    innerHeight: 600,
    addEventListener(type, handler) {
      windowListeners.set(type, handler);
    },
    requestAnimationFrame(fn) {
      fn();
      return 1;
    },
    setTimeout() {
      return 1;
    },
  };
  const posted = [];
  const parent = {
    postMessage(message) {
      posted.push(message);
    },
  };
  const ui = installReadAloudButtons({ window, document, parent });
  const host = documentElement.children[0];
  const buttons = host ? host.shadow.children.filter((child) => child.tagName === "BUTTON") : [];
  const highlight = host ? host.shadow.children.find((child) => child.className === "lavish-ra-highlight") : null;
  const message = (data, source = /** @type {any} */ (parent)) => windowListeners.get("message")({ source, data });
  return { ui, host, buttons, highlight, posted, message, documentElement };
}

test("read-aloud draws one gutter button per block inside a lavish-ui shadow host and announces the count", () => {
  const members = [
    readAloudMember(0, { left: 120, top: 50, width: 400, height: 40 }),
    readAloudMember(0, { left: 120, top: 100, width: 400, height: 60 }),
    readAloudMember(1, { left: 10, top: 200, width: 300, height: 20 }),
  ];
  const { host, buttons, highlight, posted } = readAloudHarness(members);

  assert.equal(host.getAttribute("data-lavish-ui"), "read-aloud");
  assert.match(host.style.cssText, /position:absolute/);
  assert.equal(buttons.length, 2, "one button per block, not per member");
  assert.equal(buttons[0].getAttribute("data-block"), "0");
  assert.equal(buttons[0].getAttribute("aria-label"), "Play block 1");
  assert.equal(buttons[0].style.left, "84px", "left gutter: 120 - 28 - 8");
  assert.equal(buttons[0].style.top, "150px", "top 50 + scroll 100, top-aligned with a 40px block");
  assert.equal(buttons[1].style.left, "278px", "no gutter: inside the top-right corner, 310 - 28 - 4");
  assert.equal(buttons[1].style.top, "296px", "a 20px block centers the 28px button: 300 - 4");
  assert.equal(highlight.hidden, true);
  assert.deepEqual(posted, [{ type: "lavish:readAloudReady", blocks: 2 }]);
});

test("a tap on a block button asks the chrome to play that block", () => {
  const { buttons, posted } = readAloudHarness([readAloudMember(3, { left: 100, top: 0, width: 100, height: 10 })]);
  let prevented = 0;
  buttons[0].dispatch("click", {
    preventDefault: () => (prevented += 1),
    stopPropagation() {},
  });
  assert.equal(prevented, 1);
  assert.deepEqual(posted.at(-1), { type: "lavish:readAloudPlay", block: 3 });
});

test("state messages toggle the active button, the highlight, and one scroll per block", () => {
  const members = [
    readAloudMember(0, { left: 120, top: 50, width: 400, height: 40 }),
    readAloudMember(1, { left: 120, top: 900, width: 400, height: 30 }),
    readAloudMember(1, { left: 120, top: 940, width: 380, height: 30 }),
  ];
  const { buttons, highlight, message } = readAloudHarness(members);

  message({ type: "lavish:readAloud", state: "loading", block: 1 });
  assert.ok(buttons[1].classList.contains("active"));
  assert.ok(buttons[1].classList.contains("loading"));
  assert.match(buttons[1].innerHTML, /<rect/, "pause icon while loading");
  assert.equal(buttons[1].getAttribute("aria-label"), "Pause block 2");
  assert.equal(members[1].scrolls, 1, "an off-screen block scrolls into view");

  message({ type: "lavish:readAloud", state: "playing", block: 1 });
  assert.ok(!buttons[1].classList.contains("loading"));
  assert.equal(members[1].scrolls, 1, "the same block does not scroll again");
  assert.equal(highlight.hidden, false);
  assert.equal(highlight.style.left, "116px");
  assert.equal(highlight.style.top, "996px");
  assert.equal(highlight.style.width, "408px");
  assert.equal(highlight.style.height, "78px");
  assert.ok(!buttons[0].classList.contains("active"));

  message({ type: "lavish:readAloud", state: "paused", block: 1 });
  assert.match(buttons[1].innerHTML, /<path/, "play icon while paused");
  assert.ok(buttons[1].classList.contains("active"));

  message({ type: "lavish:readAloud", state: "idle", block: -1 });
  assert.ok(!buttons[1].classList.contains("active"));
  assert.equal(highlight.hidden, true);
  message({ type: "lavish:readAloud", state: "playing", block: 1 });
  assert.equal(members[1].scrolls, 2, "after idle the block scrolls again");
});

test("read-aloud ignores messages from other windows and hides buttons of collapsed blocks", () => {
  const members = [
    readAloudMember(0, { left: 120, top: 50, width: 400, height: 40 }),
    readAloudMember(1, { left: 120, top: 50, width: 0, height: 0 }),
  ];
  const { buttons, message } = readAloudHarness(members);
  assert.equal(buttons[1].hidden, true);
  message({ type: "lavish:readAloud", state: "playing", block: 0 }, { other: true });
  assert.ok(!buttons[0].classList.contains("active"));
});

test("read-aloud with no tagged blocks adds no host and still announces zero", () => {
  const { host, posted } = readAloudHarness([]);
  assert.equal(host, undefined);
  assert.deepEqual(posted, [{ type: "lavish:readAloudReady", blocks: 0 }]);
});
