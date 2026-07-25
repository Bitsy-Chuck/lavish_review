import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../src/chrome-client.js", import.meta.url);

/** @typedef {{ key: string, file: string, layoutGateEnabled?: boolean, layoutGateMaxHoldMs?: number, modeToggleHotkeyKey?: string }} HarnessSessionData */
/** @type {HarnessSessionData} */
const defaultSessionData = { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "i" };

async function createChromeHarness({
  fetchImpl = async () => ({ ok: true }),
  sessionData = defaultSessionData,
  artifactSrc = "",
  narrowScreen = false,
} = {}) {
  const source = await readFile(sourceUrl, "utf8");
  const storage = new Map();
  const postedToFrame = [];
  const postedToWhiteboard = [];
  const inlineWhiteboards = [];
  const eventSources = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const elements = new Map();
  const timers = new Map();
  const srcLoads = [];
  let nextTimerId = 1;
  let reloadCount = 0;

  function fakeSetTimeout(fn, ms) {
    const timer = {
      id: nextTimerId++,
      ms,
      fn,
      unref() {},
    };
    timers.set(timer.id, timer);
    return timer;
  }

  function fakeClearTimeout(timer) {
    if (timer && typeof timer === "object") timers.delete(timer.id);
  }

  function runTimers(ms) {
    for (const timer of [...timers.values()]) {
      if (ms !== undefined && timer.ms !== ms) continue;
      timers.delete(timer.id);
      timer.fn();
    }
  }

  // Jittered delays have no fixed ms to match on, so let callers select by range.
  function runTimersWhere(predicate) {
    let ran = 0;
    for (const timer of [...timers.values()]) {
      if (!predicate({ id: timer.id, ms: timer.ms })) continue;
      timers.delete(timer.id);
      timer.fn();
      ran += 1;
    }
    return ran;
  }

  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const classes = new Set();
    const el = {
      id,
      hidden: false,
      disabled: false,
      value: "",
      innerHTML: "",
      textContent: "",
      scrollTop: 0,
      scrollHeight: 0,
      scrolledIntoView: null,
      dataset: {},
      onclick: null,
      classList: {
        add(...names) {
          for (const name of names) classes.add(name);
        },
        remove(...names) {
          for (const name of names) classes.delete(name);
        },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : Boolean(force);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
        contains(name) {
          return classes.has(name);
        },
        toString() {
          return [...classes].join(" ");
        },
      },
      style: {},
      setAttribute(name, value) {
        this[name] = String(value);
      },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      // The sheet handle asks whether a pointer landed on the toggle button, so the stub needs a
      // real containment answer rather than the default "no children" one.
      contains(other) {
        return other === this;
      },
      dispatch(type, event = {}) {
        const handler = listeners.get(type);
        assert.ok(handler, `element #${id} has a ${type} listener`);
        return handler(event);
      },
      querySelectorAll() {
        return [];
      },
      querySelector(selector) {
        if (selector !== "span") return null;
        const childId = `${id}:span`;
        if (!elements.has(childId)) element(childId);
        return elements.get(childId);
      },
      appendChild(child) {
        child.parentElement = this;
        this.lastAppendedChild = child;
        return child;
      },
      click(event = {}) {
        this.clicked = true;
        if (typeof this.onclick === "function") return this.onclick(event);
        return undefined;
      },
      remove() {},
      focus() {
        this.focused = true;
      },
      select() {},
      scrollIntoView(options) {
        this.scrolledIntoView = options;
      },
      listeners,
    };
    elements.set(id, el);
    return el;
  }

  element("lavish-session").textContent = JSON.stringify(sessionData);
  const frame = element("artifact");
  frame.dataset.artifactSrc = artifactSrc;
  Object.defineProperty(frame, "src", {
    get() {
      return this.currentSrc || "";
    },
    set(value) {
      this.currentSrc = String(value);
      srcLoads.push({ src: this.currentSrc, hadMessageListener: windowListeners.has("message") });
    },
  });
  frame.contentWindow = {
    postMessage(message) {
      postedToFrame.push(message);
    },
  };
  const whiteboardFrame = element("whiteboardFrame");
  whiteboardFrame.contentWindow = {
    postMessage(message) {
      postedToWhiteboard.push(message);
    },
  };

  const context = {
    clearTimeout: fakeClearTimeout,
    console,
    fetch: fetchImpl,
    location: {
      reload() {
        reloadCount += 1;
      },
    },
    navigator: {},
    setTimeout: fakeSetTimeout,
    URL: {
      createObjectURL() {
        return "blob:lavish-test";
      },
      revokeObjectURL() {},
    },
    EventSource: class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.closed = false;
        eventSources.push(this);
      }

      addEventListener(type, handler) {
        this.listeners.set(type, handler);
      }

      close() {
        this.closed = true;
      }
    },
    document: {
      body: element("body"),
      getElementById(id) {
        return element(id);
      },
      addEventListener(type, handler, capture) {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push({ handler, capture: Boolean(capture) });
      },
      createElement(tag) {
        const el = element(`${tag}-${elements.size}`);
        el.tagName = tag.toUpperCase();
        return el;
      },
      execCommand() {
        return true;
      },
    },
    sessionStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    window: {
      addEventListener(type, handler) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(handler);
      },
      // The mobile conversation sheet only exists below the chrome's narrow breakpoint; every entry
      // point checks this before it does anything.
      matchMedia(media) {
        return { media, matches: narrowScreen, addEventListener() {}, removeEventListener() {} };
      },
    },
  };

  vm.runInNewContext(source, context, { filename: "chrome-client.js" });

  return {
    element,
    frame,
    postedToFrame,
    postedToWhiteboard,
    createInlineWhiteboard() {
      const posted = [];
      const source = {
        postMessage(message) {
          posted.push(message);
        },
      };
      const whiteboard = { source, posted };
      inlineWhiteboards.push(whiteboard);
      return whiteboard;
    },
    eventSource() {
      assert.equal(eventSources.length, 1);
      return eventSources[0];
    },
    eventSources() {
      return eventSources;
    },
    latestEventSource() {
      return eventSources[eventSources.length - 1];
    },
    sendFrameMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: frame.contentWindow, data });
    },
    sendWhiteboardMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: whiteboardFrame.contentWindow, data });
    },
    sendInlineWhiteboardMessage(whiteboard, data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: whiteboard.source, data });
    },
    dispatchDocumentPointerDown(eventProps) {
      const handlers = documentListeners.get("pointerdown") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a document pointerdown handler");
      for (const { handler } of handlers) handler({ button: 0, clientY: 0, ...eventProps });
    },
    dispatchDocumentPointerUp(eventProps) {
      const handlers = documentListeners.get("pointerup") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a document pointerup handler");
      for (const { handler } of handlers) handler({ button: 0, clientY: 0, ...eventProps });
    },
    dispatchDocumentKeydown(eventProps) {
      const handlers = documentListeners.get("keydown") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a document keydown handler");
      const event = {
        key: "",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        isComposing: false,
        defaultPrevented: false,
        ...eventProps,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const { handler } of handlers) handler(event);
      return event;
    },
    queued() {
      return JSON.parse(storage.get("lavish-axi:queued:abc") || "[]");
    },
    reloadCount() {
      return reloadCount;
    },
    runTimers,
    runTimersWhere,
    srcLoads,
  };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("chrome client replaces queued prompts with the same internal key", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Use plan A", selector: "input#plan-a", tag: "choice", text: "Plan A", _lavishQueueKey: "plan" },
  });
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B", _lavishQueueKey: "plan" },
  });
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Apply dark mode", selector: "button#dark", tag: "choice", text: "Dark" },
  });

  assert.deepEqual(
    chrome.queued().map((prompt) => prompt.prompt),
    ["Use plan B", "Apply dark mode"],
  );
  assert.match(chrome.element("annotationPills").innerHTML, /Use plan B/);
  assert.doesNotMatch(chrome.element("annotationPills").innerHTML, /Use plan A/);
});

test("chrome client scrolls new chat bubbles into view above queued prompts", async () => {
  const chrome = await createChromeHarness();
  const panelScroll = chrome.element("panelScroll");
  panelScroll.scrollHeight = 1800;

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Review the title", selector: "h1", tag: "annotation", text: "Title" },
  });
  assert.equal(panelScroll.scrollTop, 1800);

  panelScroll.scrollTop = 640;
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ text: "I updated the title." }),
  });

  const bubble = chrome.element("chatLog").lastAppendedChild;
  assert.equal(bubble.scrolledIntoView.block, "nearest");
  assert.equal(bubble.scrolledIntoView.inline, "nearest");
  assert.equal(panelScroll.scrollTop, 640);
});

test("chrome client posts layout warnings from the artifact iframe", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 18,
        viewportWidth: 720,
        severity: "error",
      },
    ],
  });
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/abc/layout-warnings");
  assert.deepEqual(posts[0].body, {
    layout_warnings: [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 18,
        viewportWidth: 720,
        severity: "error",
      },
    ],
  });
});

test("chrome client surfaces export warnings from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-lavish-export-warning-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(chrome.element("exportArtifact").querySelector("span").textContent, "Exported with 1 unresolved asset");
});

test("chrome client surfaces export notices from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-lavish-export-warning-count") return "0";
          if (name.toLowerCase() === "x-lavish-export-notice-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(chrome.element("exportArtifact").querySelector("span").textContent, "Exported with 1 notice");
});

test("chrome client includes export notices alongside unresolved assets", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-lavish-export-warning-count") return "2";
          if (name.toLowerCase() === "x-lavish-export-notice-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(
    chrome.element("exportArtifact").querySelector("span").textContent,
    "Exported with 2 unresolved assets and 1 notice",
  );
});

test("chrome client surfaces share warnings from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        url: "https://abc123.ht-ml.app/",
        update_key: "uk_secret",
        warnings: [
          { kind: "load-failed", ref: "missing.png" },
          { kind: "csp-meta", ref: "script-src 'self'" },
        ],
        unresolved_local_assets: [{ kind: "load-failed", ref: "missing.png" }],
        notices: [{ kind: "csp-meta", ref: "script-src 'self'" }],
      }),
    }),
  });
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.equal(chrome.element("shareStatus").textContent, "Published with 1 unresolved local asset and 1 notice.");
  assert.equal(chrome.element("shareResult").hidden, false);
});

test("chrome client does not count share notices as unresolved assets", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        url: "https://abc123.ht-ml.app/",
        update_key: "uk_secret",
        warnings: [{ kind: "csp-meta", ref: "script-src 'self'" }],
        notices: [{ kind: "csp-meta", ref: "script-src 'self'" }],
      }),
    }),
  });
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.equal(chrome.element("shareStatus").textContent, "Published with 1 notice.");
  assert.equal(chrome.element("shareResult").hidden, false);
});

test("chrome client clears stale share passwords when opening a fresh dialog", async () => {
  const chrome = await createChromeHarness();

  chrome.element("sharePassword").value = "old-password";
  chrome.element("shareArtifact").onclick();

  assert.equal(chrome.element("sharePassword").value, "");
});

test("chrome client preserves share passwords during an in-dialog retry", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: false,
      json: async () => ({ error: "publish failed" }),
    }),
  });

  chrome.element("shareArtifact").onclick();
  chrome.element("sharePassword").value = "pw";
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.equal(chrome.element("sharePassword").value, "pw");
  assert.equal(chrome.element("shareStatus").textContent, "publish failed");
});

test("chrome client says password-protected shares also require the password", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        url: "https://abc123.ht-ml.app/",
        update_key: "uk_secret",
      }),
    }),
  });
  chrome.element("sharePassword").value = "pw";
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.equal(
    chrome.element("shareStatus").textContent,
    "Published. This page is PASSWORD-PROTECTED; viewers also need the password.",
  );
});

test("chrome client treats a whitespace-only share password as public", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (_url, init) => {
      posts.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({
          url: "https://abc123.ht-ml.app/",
          update_key: "uk_secret",
        }),
      };
    },
  });
  chrome.element("sharePassword").value = "   ";
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.deepEqual(posts, [{}]);
  assert.equal(chrome.element("shareStatus").textContent, "Published. Anyone with the link can view this page.");
});

test("chrome client registers message listener before loading the artifact iframe", async () => {
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html" });

  assert.deepEqual(chrome.srcLoads, [{ src: "/artifact/abc/index.html", hadMessageListener: true }]);
});

test("layout gate reveals after a clean audit result", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);

  chrome.sendFrameMessage({ type: "lavish:layoutWarnings", layout_warnings: [] });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
  assert.deepEqual(posts[0], { url: "/api/abc/layout-warnings", body: { layout_warnings: [] } });
});

test("layout gate holds on error severity audit findings and still posts them", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 18,
        viewportWidth: 720,
        severity: "error",
      },
    ],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);
  assert.match(chrome.element("layoutGateTitle").innerHTML, /Fixing a layout issue/);
  assert.deepEqual(posts[0].body.layout_warnings[0].severity, "error");
});

test("layout gate does not hold on warning severity audit findings", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [
      {
        selector: ".card",
        kind: "text-clipped",
        overflowPx: 2,
        viewportWidth: 720,
        severity: "warning",
      },
    ],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
});

test("layout gate timeout reveals with a persistent layout issue banner", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  assert.equal(chrome.element("layoutGateOverlay").hidden, false);

  chrome.runTimers(25);

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, false);
  assert.match(chrome.element("layoutIssueBanner").textContent, /may have layout issues/);
});

test("layout gate timeout re-arms on reload", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  chrome.runTimers(25);
  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, false);

  chrome.eventSource().listeners.get("reload")();

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.match(chrome.element("layoutGateTitle").innerHTML, /Fixing a layout issue/);
});

test("layout gate manual override reveals immediately", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  chrome.element("layoutGateAction").onclick();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, false);
});

test("layout gate manual override stays bypassed on reload", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  chrome.element("layoutGateAction").onclick();
  chrome.eventSource().listeners.get("reload")();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, false);
});

test("layout gate stays skipped when the session disables it", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateEnabled: false },
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
});

test("chrome client strips the internal queue key before posting prompts", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B", _lavishQueueKey: "plan" },
  });
  chrome.element("send").onclick();
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:requestSnapshot");

  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/abc/prompts");
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B" }],
    domSnapshot: "uid=1 body",
  });
  assert.equal(chrome.queued().length, 0);
});

test("chrome send and end carries the end intent with queued prompts", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" },
  });
  chrome.element("sendAndEnd").onclick();
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:requestSnapshot");

  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.deepEqual(
    posts.map((post) => post.url),
    ["/api/abc/prompts"],
  );
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" }],
    domSnapshot: "uid=1 body",
    endSession: true,
  });
  assert.equal(chrome.queued().length, 0);
  assert.equal(chrome.element("chatInput").disabled, true);
});

test("chrome send and end with an empty composer nudges instead of ending", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });
  chrome.element("sendHint").hidden = true;

  chrome.element("sendAndEnd").onclick();
  await flushPromises();

  assert.equal(posts.length, 0);
  assert.equal(chrome.postedToFrame.length, 0);
  assert.equal(chrome.element("sendHint").hidden, false);
  assert.equal(chrome.element("chatInput").focused, true);
  assert.equal(chrome.element("chatInput").disabled, false);
});

test("chrome send and end during an in-flight submit still ends after the submit drains the queue", async () => {
  const posts = [];
  let resolveFirstPost = () => {};
  const firstPost = new Promise((resolve) => {
    resolveFirstPost = () => resolve();
  });
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (posts.length === 1) await firstPost;
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" },
  });
  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);

  chrome.element("sendAndEnd").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);

  resolveFirstPost();
  await flushPromises();
  await flushPromises();

  assert.deepEqual(
    posts.map((post) => post.url),
    ["/api/abc/prompts", "/api/abc/end"],
  );
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" }],
    domSnapshot: "uid=1 body",
  });
  assert.equal(posts[1].body, null);
  assert.equal(chrome.queued().length, 0);
  assert.equal(chrome.element("chatInput").disabled, true);
});

test("Cmd/Ctrl+I toggles annotation mode from the chrome document, regardless of focus", async () => {
  const chrome = await createChromeHarness();

  const metaEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(metaEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);

  const ctrlEvent = chrome.dispatchDocumentKeydown({ key: "I", ctrlKey: true });
  assert.equal(ctrlEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);
});

test("plain 'i' and other modifier combos do not toggle annotation mode", async () => {
  const chrome = await createChromeHarness();
  const framePostCount = () => chrome.postedToFrame.length;
  const before = framePostCount();

  const bareEvent = chrome.dispatchDocumentKeydown({ key: "i" });
  assert.equal(bareEvent.defaultPrevented, false);
  assert.equal(chrome.element("annotation")["aria-pressed"], undefined);

  const shiftEvent = chrome.dispatchDocumentKeydown({ key: "i", shiftKey: true });
  assert.equal(shiftEvent.defaultPrevented, false);

  const ctrlShiftEvent = chrome.dispatchDocumentKeydown({ key: "i", ctrlKey: true, shiftKey: true });
  assert.equal(ctrlShiftEvent.defaultPrevented, false);

  const metaAltEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true, altKey: true });
  assert.equal(metaAltEvent.defaultPrevented, false);

  const otherKeyEvent = chrome.dispatchDocumentKeydown({ key: "s", metaKey: true });
  assert.equal(otherKeyEvent.defaultPrevented, false);

  assert.equal(framePostCount(), before);
});

test("chrome client reads the mode toggle hotkey from the session bootstrap", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "k" },
  });

  const oldHotkeyEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(oldHotkeyEvent.defaultPrevented, false);
  assert.equal(chrome.element("annotation")["aria-pressed"], undefined);

  const bootstrapHotkeyEvent = chrome.dispatchDocumentKeydown({ key: "K", metaKey: true });
  assert.equal(bootstrapHotkeyEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);
});

test("chrome client toggles annotation mode when the artifact SDK requests it via postMessage", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({ type: "lavish:toggleAnnotationMode" });

  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);

  chrome.sendFrameMessage({ type: "lavish:toggleAnnotationMode" });
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);
});

test("chrome client ignores annotation mode toggles after the session ends", async () => {
  const chrome = await createChromeHarness();

  chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");

  chrome.sendFrameMessage({ type: "lavish:endSession" });
  await flushPromises();
  const afterEndPostCount = chrome.postedToFrame.length;

  chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  chrome.sendFrameMessage({ type: "lavish:toggleAnnotationMode" });

  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.length, afterEndPostCount);
});

function whiteboardFetch(url) {
  if (url.includes("/whiteboard-channel")) return { ok: true };
  if (url.includes("/mermaid-sources")) {
    return { ok: true, json: async () => ({ sources: [{ index: 0, source: "flowchart TD; A-->B", hash: "hash" }] }) };
  }
  return { ok: true, json: async () => ({ whiteboard: null }) };
}

async function initializeInlineWhiteboard(chrome, token = "inline-channel") {
  const whiteboard = chrome.createInlineWhiteboard();
  chrome.sendInlineWhiteboardMessage(whiteboard, {
    type: "lavish-whiteboard:ready",
    diagramIndex: 0,
    diagramId: "mermaid-1",
    channelToken: token,
  });
  await flushPromises();
  await flushPromises();
  return whiteboard;
}

test("artifact relays cannot invoke whiteboard persistence", async () => {
  const calls = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return whiteboardFetch(url);
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:whiteboardRelay",
    diagramIndex: 0,
    message: { type: "lavish-whiteboard:save", scene: { elements: [{ id: "forged" }] } },
  });
  await flushPromises();

  assert.equal(calls.length, 0);
  assert.equal(chrome.postedToFrame.length, 0);
});

test("unverified whiteboard frames cannot invoke whiteboard persistence", async () => {
  const calls = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return { ok: false };
    },
  });
  const whiteboard = chrome.createInlineWhiteboard();

  chrome.sendInlineWhiteboardMessage(whiteboard, {
    type: "lavish-whiteboard:ready",
    diagramIndex: 0,
    channelToken: "forged",
  });
  await flushPromises();
  chrome.sendInlineWhiteboardMessage(whiteboard, {
    type: "lavish-whiteboard:save",
    diagramIndex: 0,
    channelId: "forged",
    scene: { elements: [{ id: "forged" }] },
  });
  await flushPromises();

  assert.deepEqual(
    calls.map((call) => call.url),
    ["/api/abc/whiteboard-channel"],
  );
  assert.equal(whiteboard.posted.length, 0);
});

test("whiteboard fullscreen waits for the authenticated inline frame to flush", async () => {
  const chrome = await createChromeHarness({ fetchImpl: async (url) => whiteboardFetch(url) });
  const inline = await initializeInlineWhiteboard(chrome);
  const init = inline.posted.at(-1);
  assert.equal(init.type, "lavish-whiteboard:init");
  assert.equal(init.channelId, "inline-channel");

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });

  const prepare = inline.posted.at(-1);
  assert.equal(prepare.type, "lavish-whiteboard:prepareTeardown");
  assert.equal(
    chrome.postedToFrame.some((message) => message.type === "lavish:suspendWhiteboard"),
    false,
  );

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: prepare.flushId,
  });

  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:suspendWhiteboard");
  assert.match(chrome.element("whiteboardFrame").src, /^\/whiteboard-frame\?diagramIndex=0$/);
});

test("whiteboard close waits for the authenticated overlay frame to flush", async () => {
  const chrome = await createChromeHarness({ fetchImpl: async (url) => whiteboardFetch(url) });
  const inline = await initializeInlineWhiteboard(chrome);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });
  const maximizePrepare = inline.posted.at(-1);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: maximizePrepare.flushId,
  });
  chrome.sendWhiteboardMessage({ type: "lavish-whiteboard:ready", diagramIndex: 0, channelToken: "overlay-channel" });
  await flushPromises();
  await flushPromises();

  chrome.element("whiteboardClose").click();
  const closePrepare = chrome.postedToWhiteboard.at(-1);
  assert.equal(closePrepare.type, "lavish-whiteboard:prepareTeardown");
  assert.equal(closePrepare.channelId, "overlay-channel");
  assert.notEqual(chrome.element("whiteboardFrame").src, "about:blank");

  chrome.sendWhiteboardMessage({
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "overlay-channel",
    flushId: closePrepare.flushId,
  });

  assert.equal(chrome.element("whiteboardFrame").src, "about:blank");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:resumeWhiteboard");
});

test("whiteboard fullscreen close accepts the resumed inline frame", async () => {
  const chrome = await createChromeHarness({ fetchImpl: async (url) => whiteboardFetch(url) });
  const inline = await initializeInlineWhiteboard(chrome);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });
  const maximizePrepare = inline.posted.at(-1);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: maximizePrepare.flushId,
  });
  chrome.sendWhiteboardMessage({ type: "lavish-whiteboard:ready", diagramIndex: 0, channelToken: "overlay-channel" });
  await flushPromises();
  await flushPromises();

  chrome.element("whiteboardClose").click();
  const closePrepare = chrome.postedToWhiteboard.at(-1);
  chrome.sendWhiteboardMessage({
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "overlay-channel",
    flushId: closePrepare.flushId,
  });

  const resumed = chrome.createInlineWhiteboard();
  chrome.sendInlineWhiteboardMessage(resumed, {
    type: "lavish-whiteboard:ready",
    diagramIndex: 0,
    diagramId: "mermaid-1",
    channelToken: "resumed-channel",
  });
  await flushPromises();
  await flushPromises();

  assert.equal(resumed.posted.at(-1).type, "lavish-whiteboard:init");
  assert.equal(resumed.posted.at(-1).channelId, "resumed-channel");
});

test("artifact reload waits for inline whiteboards to flush", async () => {
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: async (url) => whiteboardFetch(url),
  });
  const inline = await initializeInlineWhiteboard(chrome);
  const initialLoadCount = chrome.srcLoads.length;

  chrome.element("reloadArtifact").click();
  const prepare = inline.posted.at(-1);
  assert.equal(prepare.type, "lavish-whiteboard:prepareTeardown");
  assert.equal(chrome.srcLoads.length, initialLoadCount);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: prepare.flushId,
  });
  await flushPromises();

  assert.equal(chrome.srcLoads.length, initialLoadCount + 1);
  assert.equal(chrome.element("artifact").src, "/artifact/abc/index.html");
});

test("server restart flushes an authenticated inline whiteboard before reloading", async () => {
  let healthChecks = 0;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (url === "/health") {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error("server is restarting");
        return { ok: true };
      }
      return whiteboardFetch(url);
    },
  });
  const inline = await initializeInlineWhiteboard(chrome);

  const restart = chrome.eventSource().listeners.get("chrome-reload")();
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();

  const flush = inline.posted.at(-1);
  assert.equal(flush.type, "lavish-whiteboard:flush");
  assert.equal(chrome.reloadCount(), 0);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:flushComplete",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: flush.flushId,
    ok: true,
  });
  await restart;

  assert.equal(chrome.reloadCount(), 1);
});

test("server restart flushes an authenticated overlay before reloading", async () => {
  let healthChecks = 0;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (url === "/health") {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error("server is restarting");
        return { ok: true };
      }
      return whiteboardFetch(url);
    },
  });
  const inline = await initializeInlineWhiteboard(chrome);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });
  const teardown = inline.posted.at(-1);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: teardown.flushId,
  });
  chrome.sendWhiteboardMessage({ type: "lavish-whiteboard:ready", diagramIndex: 0, channelToken: "overlay-channel" });
  await flushPromises();
  await flushPromises();

  const restart = chrome.eventSource().listeners.get("chrome-reload")();
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();

  const flush = chrome.postedToWhiteboard.at(-1);
  assert.equal(flush.type, "lavish-whiteboard:flush");
  assert.equal(chrome.reloadCount(), 0);

  chrome.sendWhiteboardMessage({
    type: "lavish-whiteboard:flushComplete",
    diagramIndex: 0,
    channelId: "overlay-channel",
    flushId: flush.flushId,
    ok: true,
  });
  await restart;

  assert.equal(chrome.reloadCount(), 1);
});

test("server restart bounds the wait for a whiteboard flush", async () => {
  let healthChecks = 0;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (url === "/health") {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error("server is restarting");
        return { ok: true };
      }
      return whiteboardFetch(url);
    },
  });
  const inline = await initializeInlineWhiteboard(chrome);

  const restart = chrome.eventSource().listeners.get("chrome-reload")();
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();

  assert.equal(inline.posted.at(-1).type, "lavish-whiteboard:flush");
  chrome.runTimers(1500);
  await restart;

  assert.equal(chrome.reloadCount(), 1);
});

test("whiteboard close stays responsive while overlay initialization is pending", async () => {
  let delayOverlaySources = false;
  /** @type {(() => void) | undefined} */
  let releaseOverlaySources;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (delayOverlaySources && url.includes("/mermaid-sources")) {
        await new Promise((resolve) => {
          releaseOverlaySources = () => resolve();
        });
      }
      return whiteboardFetch(url);
    },
  });
  const inline = await initializeInlineWhiteboard(chrome);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });
  const maximizePrepare = inline.posted.at(-1);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: maximizePrepare.flushId,
  });

  delayOverlaySources = true;
  chrome.sendWhiteboardMessage({ type: "lavish-whiteboard:ready", diagramIndex: 0, channelToken: "overlay-channel" });
  await flushPromises();
  chrome.element("whiteboardClose").click();

  assert.equal(chrome.element("whiteboardFrame").src, "about:blank");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:resumeWhiteboard");
  assert.equal(
    chrome.postedToWhiteboard.some((message) => message.type === "lavish-whiteboard:prepareTeardown"),
    false,
  );

  releaseOverlaySources?.();
  await flushPromises();
});

test("chrome client reconnects the event stream after an error and resyncs authoritative state", async () => {
  const requests = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      requests.push(url);
      return {
        ok: true,
        json: async () => ({
          status: "open",
          ended: false,
          presence: "listening",
          chat: [{ role: "agent", text: "Reply you missed while offline" }],
        }),
      };
    },
  });

  const first = chrome.latestEventSource();
  first.listeners.get("open")();
  assert.equal(chrome.element("connectionBanner").hidden, true);

  first.listeners.get("error")();

  // The dead stream is explicitly closed - the spec will not retry a stream that failed on a
  // non-200 response, so leaving it open would leave the page deaf forever.
  assert.equal(first.closed, true);
  assert.equal(chrome.element("connectionBanner").hidden, false);
  assert.equal(chrome.eventSources().length, 1);

  // Backoff, not a hot loop: the first retry lands inside the jittered 1s window.
  const ran = chrome.runTimersWhere((timer) => timer.ms >= 500 && timer.ms <= 1000);
  assert.equal(ran, 1);
  assert.equal(chrome.eventSources().length, 2);

  const second = chrome.latestEventSource();
  second.listeners.get("open")();
  await flushPromises();

  assert.equal(chrome.element("connectionBanner").hidden, true);
  assert.ok(requests.includes("/api/abc/state"));
  assert.match(chrome.element("chatLog").lastAppendedChild.innerHTML, /Reply you missed while offline/);
  assert.equal(chrome.element("send").disabled, false);
});

test("chrome client treats a silent event stream as dead even without an error", async () => {
  const chrome = await createChromeHarness();

  const first = chrome.latestEventSource();
  first.listeners.get("open")();
  assert.equal(chrome.element("connectionBanner").hidden, true);

  // No heartbeat for three intervals: a half-open connection never fires `error`.
  chrome.runTimers(50_000);

  assert.equal(first.closed, true);
  assert.equal(chrome.element("connectionBanner").hidden, false);
  chrome.runTimersWhere((timer) => timer.ms >= 500 && timer.ms <= 1000);
  assert.equal(chrome.eventSources().length, 2);
});

test("chrome client stops reconnecting once the session has ended", async () => {
  const chrome = await createChromeHarness();

  const stream = chrome.latestEventSource();
  stream.listeners.get("open")();
  stream.listeners.get("session-ended")();

  assert.equal(chrome.element("endedOverlay").hidden, false);
  assert.equal(stream.closed, true);

  stream.listeners.get("error")();
  chrome.runTimersWhere((timer) => timer.ms >= 500 && timer.ms <= 15_000);

  assert.equal(chrome.eventSources().length, 1);
  assert.equal(chrome.element("connectionBanner").hidden, true);
});

test("chrome client unlocks the composer when a working presence goes stale", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({ ok: true, json: async () => ({ presence: "working", ended: false, chat: [] }) }),
  });

  chrome.eventSource().listeners.get("agent-presence")({ data: JSON.stringify({ state: "working" }) });
  assert.equal(chrome.element("send").disabled, true);
  assert.equal(chrome.element("sendAndEnd").disabled, true);
  assert.match(chrome.element("chatLog").lastAppendedChild.innerHTML, /Working\.\.\./);

  chrome.runTimers(45_000);
  await flushPromises();

  assert.equal(chrome.element("send").disabled, false);
  assert.equal(chrome.element("sendAndEnd").disabled, false);
  const bubble = chrome.element("chatLog").lastAppendedChild;
  assert.ok(bubble.classList.contains("agent-stalled"));
  assert.match(bubble.innerHTML, /No word from your agent for a while/);
});

test("chrome client re-locks the composer when the agent starts working again", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({ ok: true, json: async () => ({ presence: "working", ended: false, chat: [] }) }),
  });
  const presence = chrome.eventSource().listeners.get("agent-presence");

  presence({ data: JSON.stringify({ state: "working" }) });
  chrome.runTimers(45_000);
  await flushPromises();
  assert.equal(chrome.element("send").disabled, false);

  presence({ data: JSON.stringify({ state: "listening" }) });
  assert.equal(chrome.element("send").disabled, false);

  presence({ data: JSON.stringify({ state: "working" }) });
  assert.equal(chrome.element("send").disabled, true);
});

test("chrome client sends without a snapshot when the artifact never answers", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Fix the header", selector: "h1", tag: "annotation", text: "Header" },
  });
  chrome.element("send").onclick();
  assert.equal(posts.length, 0);

  chrome.runTimers(2500);
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/abc/prompts");
  assert.equal(posts[0].body.domSnapshot, "");
  assert.match(chrome.element("sendHint").textContent, /without a page snapshot/);
  assert.equal(chrome.queued().length, 0);

  // A snapshot that finally arrives after the timeout must not submit the queue a second time.
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "late" });
  await flushPromises();
  assert.equal(posts.length, 1);
});

test("chrome client keeps the typed message and offers a retry when the submit fails", async () => {
  const posts = [];
  let ok = false;
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return { ok };
    },
  });

  chrome.element("chatInput").value = "Please tighten the spacing";
  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.equal(posts.length, 1);
  // The composer never loses text the server did not accept.
  assert.equal(chrome.element("chatInput").value, "Please tighten the spacing");
  assert.equal(chrome.element("submitError").hidden, false);
  assert.equal(chrome.element("submitRetry").hidden, false);
  assert.equal(chrome.queued().length, 0);

  ok = true;
  chrome.element("submitRetry").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body.prompts, [
    { uid: "", prompt: "Please tighten the spacing", selector: "", tag: "message", text: "Freeform message" },
  ]);
  assert.equal(chrome.element("chatInput").value, "");
  assert.equal(chrome.element("submitError").hidden, true);
  assert.equal(chrome.queued().length, 0);
});

test("chrome client keeps annotation pills queued when their submit fails", async () => {
  const chrome = await createChromeHarness({ fetchImpl: async () => ({ ok: false }) });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Fix the header", selector: "h1", tag: "annotation", text: "Header" },
  });
  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.deepEqual(
    chrome.queued().map((prompt) => prompt.prompt),
    ["Fix the header"],
  );
  assert.equal(chrome.element("submitError").hidden, false);
});

test("chrome client clears the composer only after the submit succeeds", async () => {
  let releasePost = () => {};
  const held = new Promise((resolve) => {
    releasePost = () => resolve();
  });
  const chrome = await createChromeHarness({
    fetchImpl: async () => {
      await held;
      return { ok: true };
    },
  });

  chrome.element("chatInput").value = "Please tighten the spacing";
  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();

  assert.equal(chrome.element("chatInput").value, "Please tighten the spacing");
  // The in-flight message shows as a dimmed bubble, not as a duplicate pill.
  assert.ok(chrome.element("chatLog").lastAppendedChild.classList.contains("pending"));
  assert.equal(chrome.element("annotationPills").innerHTML, "");

  releasePost();
  await flushPromises();
  await flushPromises();

  assert.equal(chrome.element("chatInput").value, "");
  assert.equal(chrome.element("chatLog").lastAppendedChild.classList.contains("pending"), false);
});

// ---------------------------------------------------------------------------
// Mobile conversation sheet. The panel used to be permanently open below the narrow breakpoint,
// which on a 390x844 phone left the artifact ~433px - roughly half the screen. As a sheet it starts
// collapsed and opens itself only when there is something in it worth reading.
// ---------------------------------------------------------------------------

test("the conversation sheet starts collapsed on a narrow screen", async () => {
  const chrome = await createChromeHarness({ narrowScreen: true });

  assert.equal(chrome.element("body").dataset.lavishSheet, "collapsed");
  assert.equal(chrome.element("sheetToggle")["aria-expanded"], "false");
  assert.equal(chrome.element("sheetToggle")["aria-label"], "Expand conversation");
});

test("an agent reply opens the collapsed sheet", async () => {
  const chrome = await createChromeHarness({ narrowScreen: true });

  chrome.eventSource().listeners.get("agent-reply")({ data: JSON.stringify({ text: "Look at card two" }) });

  assert.equal(chrome.element("body").dataset.lavishSheet, "half");
  assert.equal(chrome.element("sheetToggle")["aria-expanded"], "true");
  assert.equal(chrome.element("sheetToggle")["aria-label"], "Collapse conversation");
});

test("queuing an annotation opens the sheet and shows how many are waiting", async () => {
  const chrome = await createChromeHarness({ narrowScreen: true });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Tighten this", selector: "#a", tag: "p", text: "A" },
  });

  assert.equal(chrome.element("body").dataset.lavishSheet, "half");
  assert.equal(chrome.element("sheetCount").textContent, "1");
  assert.equal(chrome.element("sheetCount").hidden, false);
});

// Auto-OPEN only. A collapse is a decision the reviewer made about their own screen; an agent reply
// may raise the sheet from collapsed, but it must never lower one the reviewer opened further.
test("an agent reply never lowers a sheet the reviewer opened wider", async () => {
  const chrome = await createChromeHarness({ narrowScreen: true });
  const toggle = chrome.element("sheetToggle");

  toggle.onclick();
  toggle.onclick();
  assert.equal(chrome.element("body").dataset.lavishSheet, "expanded");

  chrome.eventSource().listeners.get("agent-reply")({ data: JSON.stringify({ text: "Done" }) });

  assert.equal(chrome.element("body").dataset.lavishSheet, "expanded");
});

test("the sheet toggle cycles collapsed -> half -> expanded -> collapsed", async () => {
  const chrome = await createChromeHarness({ narrowScreen: true });
  const body = chrome.element("body");
  const toggle = chrome.element("sheetToggle");

  for (const expected of ["half", "expanded", "collapsed", "half"]) {
    toggle.onclick();
    assert.equal(body.dataset.lavishSheet, expected);
  }
});

test("a swipe on the sheet handle steps one state, a tap cycles", async () => {
  const chrome = await createChromeHarness({ narrowScreen: true });
  const body = chrome.element("body");
  const head = chrome.element("panelHead");
  const swipe = (from, to) => {
    chrome.dispatchDocumentPointerDown({ clientY: from, target: head });
    chrome.dispatchDocumentPointerUp({ clientY: to });
  };

  swipe(600, 500); // up
  assert.equal(body.dataset.lavishSheet, "half");
  swipe(500, 400); // up again
  assert.equal(body.dataset.lavishSheet, "expanded");
  swipe(400, 500); // down
  assert.equal(body.dataset.lavishSheet, "half");

  // Under the threshold a drag is just a finger that did not hold still - treat it as a tap.
  swipe(500, 496);
  assert.equal(body.dataset.lavishSheet, "expanded");
});

// The toggle button runs its own click handler, so the handle must not also step on its pointer -
// otherwise one tap would move the sheet twice.
test("a tap on the toggle button does not also trigger the handle swipe path", async () => {
  const chrome = await createChromeHarness({ narrowScreen: true });
  const head = chrome.element("panelHead");
  const toggle = chrome.element("sheetToggle");

  chrome.dispatchDocumentPointerDown({ clientY: 600, target: toggle });
  chrome.dispatchDocumentPointerUp({ clientY: 600 });
  assert.equal(chrome.element("body").dataset.lavishSheet, "collapsed");

  toggle.onclick();
  assert.equal(chrome.element("body").dataset.lavishSheet, "half");

  // A press that landed outside the handle entirely must not arm the swipe either.
  chrome.dispatchDocumentPointerDown({ clientY: 600, target: head.parentElement || chrome.element("artifact") });
  chrome.dispatchDocumentPointerUp({ clientY: 400 });
  assert.equal(chrome.element("body").dataset.lavishSheet, "half");
});

test("focusing the composer opens the sheet", async () => {
  const chrome = await createChromeHarness({ narrowScreen: true });

  chrome.element("chatInput").dispatch("focus");

  assert.equal(chrome.element("body").dataset.lavishSheet, "half");
});

// On desktop the panel is a plain always-visible column, so none of the sheet machinery may fire.
test("the sheet stays inert on a wide screen", async () => {
  const chrome = await createChromeHarness();

  chrome.eventSource().listeners.get("agent-reply")({ data: JSON.stringify({ text: "Look at card two" }) });
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Tighten this", selector: "#a", tag: "p", text: "A" },
  });
  chrome.element("chatInput").dispatch("focus");

  assert.equal(chrome.element("body").dataset.lavishSheet, "collapsed");
});

test("Escape collapses an open sheet, but an open menu outranks it", async () => {
  const chrome = await createChromeHarness({ narrowScreen: true });
  const body = chrome.element("body");
  // Stub elements default to visible, and Escape checks the overlays before anything else.
  chrome.element("whiteboardOverlay").hidden = true;
  chrome.element("shareDialog").hidden = true;

  chrome.element("sheetToggle").onclick();
  assert.equal(body.dataset.lavishSheet, "half");

  chrome.element("moreMenu").hidden = false;
  chrome.dispatchDocumentKeydown({ key: "Escape" });
  assert.equal(body.dataset.lavishSheet, "half");
  assert.equal(chrome.element("moreMenu").hidden, true);

  chrome.dispatchDocumentKeydown({ key: "Escape" });
  assert.equal(body.dataset.lavishSheet, "collapsed");
});
