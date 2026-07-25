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
    ["window", "document", "parent", "Element", "getComputedStyle"].map((key) => [key, globalThis[key]]),
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

  try {
    setGlobal(
      "Element",
      class {
        static [Symbol.hasInstance](value) {
          return value?.nodeType === 1;
        }
      },
    );
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
        if (selector === "svg") return [svg];
        if (selector === ".mermaid") return [container];
        return [];
      },
      createElement(tag) {
        const el = node(tag);
        el.style = {};
        el.setAttribute = (name, value) => {
          attrsFor(el)[name] = String(value);
        };
        el.getBoundingClientRect = () => rect(500, 456);
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
    assert.equal(container.style.display, "none");
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
    assert.deepEqual(hooks.auditLayout(), [
      {
        selector: "html > body > pre",
        kind: "scaled-down-diagram",
        overflowPx: 723,
        viewportWidth: 500,
        severity: "error",
      },
    ]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else setGlobal(key, value);
    }
  }
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
