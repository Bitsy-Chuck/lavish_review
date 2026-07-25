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
      children: [],
      querySelectorAll(selector) {
        // Faithful enough for chatLog's ".bubble.user,.bubble.agent:not(.agent-working)"; every
        // other selector in the chrome resolves against elements this harness does not model.
        if (!String(selector).includes(".bubble")) return [];
        return this.children.filter((child) => {
          const cls = String(child.className || "");
          if (!cls.includes("bubble")) return false;
          if (cls.includes("user")) return true;
          return cls.includes("agent") && !cls.includes("agent-working");
        });
      },
      querySelector(selector) {
        if (selector !== "span") return null;
        const childId = `${id}:span`;
        if (!elements.has(childId)) element(childId);
        return elements.get(childId);
      },
      appendChild(child) {
        if (child.parentElement) child.parentElement.children = child.parentElement.children.filter((c) => c !== child);
        child.parentElement = this;
        this.children.push(child);
        this.lastAppendedChild = child;
        return child;
      },
      click(event = {}) {
        this.clicked = true;
        if (typeof this.onclick === "function") return this.onclick(event);
        return undefined;
      },
      remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
      },
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
    sendState(payload, stream) {
      const target = stream || eventSources[eventSources.length - 1];
      const handler = target.listeners.get("state");
      assert.ok(handler, "chrome-client subscribed to the state event");
      handler({ data: JSON.stringify({ bootId: "boot-1", ...payload }) });
    },
    chatTexts() {
      return element("chatLog").children.map((child) => String(child.innerHTML));
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
    // Answers the most recent snapshot request the way the real SDK does: by echoing its id.
    lastSnapshotRequestId() {
      const request = [...postedToFrame].reverse().find((message) => message.type === "lavish:requestSnapshot");
      assert.ok(request, "chrome-client asked the artifact for a snapshot");
      return request.requestId;
    },
    answerSnapshot(snapshot, requestId) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      const data = { type: "lavish:snapshot", requestId: requestId ?? this.lastSnapshotRequestId(), snapshot };
      for (const handler of handlers) handler({ source: frame.contentWindow, data });
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
    pendingTimers() {
      return [...timers.values()].map((timer) => ({ id: timer.id, ms: timer.ms }));
    },
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
  chrome.sendState({ revision: 1, presence: "listening", chat: [{ role: "agent", text: "I updated the title." }] });

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

  chrome.answerSnapshot("uid=1 body");
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

  chrome.answerSnapshot("uid=1 body");
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
  chrome.answerSnapshot("uid=1 body");
  await flushPromises();
  assert.equal(posts.length, 1);

  chrome.element("sendAndEnd").onclick();
  chrome.answerSnapshot("uid=1 body");
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

test("chrome client reconnects the event stream after an error and recovers what it missed", async () => {
  const chrome = await createChromeHarness();

  const first = chrome.latestEventSource();
  first.listeners.get("open")();
  chrome.sendState({ revision: 1, presence: "listening", chat: [] }, first);
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
  assert.equal(chrome.element("connectionBanner").hidden, true);

  // No separate fetch: the server opens every connection with the whole state, so what arrived
  // while the page was offline is simply there.
  chrome.sendState(
    { revision: 7, presence: "listening", chat: [{ role: "agent", text: "Reply you missed while offline" }] },
    second,
  );
  assert.deepEqual(chrome.chatTexts().length, 1);
  assert.match(chrome.chatTexts()[0], /Reply you missed while offline/);
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
  chrome.sendState({ revision: 4, presence: "waiting", chat: [], ended: true }, stream);

  assert.equal(chrome.element("endedOverlay").hidden, false);
  assert.equal(stream.closed, true);

  stream.listeners.get("error")();
  chrome.runTimersWhere((timer) => timer.ms >= 500 && timer.ms <= 15_000);

  assert.equal(chrome.eventSources().length, 1);
  assert.equal(chrome.element("connectionBanner").hidden, true);
});

test("chrome client unlocks the composer when a working presence goes stale", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ bootId: "boot-1", revision: 2, presence: "working", ended: false, chat: [] }),
    }),
  });

  chrome.sendState({ revision: 1, presence: "working", chat: [] });
  assert.equal(chrome.element("send").disabled, true);
  assert.equal(chrome.element("sendAndEnd").disabled, true);
  assert.match(chrome.element("chatLog").lastAppendedChild.innerHTML, /Working\.\.\./);

  chrome.runTimers(45_000);
  await flushPromises();

  assert.equal(chrome.element("send").disabled, false);
  // Send & End stays locked: ending would tear the session down under an agent that may really
  // be working. It reopens only when the server itself reports the agent is gone.
  assert.equal(chrome.element("sendAndEnd").disabled, true);
  const bubble = chrome.element("chatLog").lastAppendedChild;
  assert.ok(bubble.classList.contains("agent-stalled"));
  assert.match(bubble.innerHTML, /No word from your agent for a while/);
});

test("chrome client re-locks the composer when the agent starts working again", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ bootId: "boot-1", revision: 2, presence: "working", ended: false, chat: [] }),
    }),
  });

  chrome.sendState({ revision: 1, presence: "working", chat: [] });
  chrome.runTimers(45_000);
  await flushPromises();
  assert.equal(chrome.element("send").disabled, false);

  chrome.sendState({ revision: 3, presence: "listening", chat: [] });
  assert.equal(chrome.element("send").disabled, false);
  assert.equal(chrome.element("sendAndEnd").disabled, false);

  chrome.sendState({ revision: 4, presence: "working", chat: [] });
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
  chrome.answerSnapshot("uid=1 body");
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
  chrome.answerSnapshot("uid=1 body");
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
  chrome.answerSnapshot("uid=1 body");
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
  chrome.answerSnapshot("uid=1 body");
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

test("a state whose content outran its revision does not duplicate chat", async () => {
  const chrome = await createChromeHarness();

  // The exact interleaving the seqlock could not close: the store commits a reply BEFORE its
  // handler bumps the revision, so a read in that window returns the reply under the OLD number.
  chrome.sendState({
    revision: 5,
    presence: "listening",
    chat: [
      { role: "user", text: "original question" },
      { role: "agent", text: "the reply" },
    ],
  });
  // The handler then pushes the same reply under its own, higher revision.
  chrome.sendState({
    revision: 6,
    presence: "listening",
    chat: [
      { role: "user", text: "original question" },
      { role: "agent", text: "the reply" },
    ],
  });

  // Whole-state application is idempotent, so the overlap is a no-op rather than a second bubble.
  assert.equal(chrome.chatTexts().length, 2);
  assert.match(chrome.chatTexts()[1], /the reply/);
});

test("a stale state cannot roll a newer one back", async () => {
  const chrome = await createChromeHarness();

  chrome.sendState({ revision: 6, presence: "listening", chat: [{ role: "agent", text: "newer reply" }] });
  assert.equal(chrome.chatTexts().length, 1);

  // A push captured before that reply, arriving late.
  chrome.sendState({ revision: 4, presence: "waiting", chat: [] });

  assert.equal(chrome.chatTexts().length, 1);
  assert.match(chrome.chatTexts()[0], /newer reply/);
});

test("a newer state from the stall re-check still applies", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (!String(url).endsWith("/state")) return { ok: true };
      return {
        ok: true,
        json: async () => ({
          bootId: "boot-1",
          revision: 9,
          presence: "listening",
          ended: false,
          chat: [{ role: "agent", text: "reply recovered by the re-check" }],
        }),
      };
    },
  });

  chrome.sendState({ revision: 1, presence: "working", chat: [] });
  chrome.runTimers(45_000);
  await flushPromises();
  await flushPromises();

  assert.match(chrome.chatTexts().at(-1), /reply recovered by the re-check/);
  assert.equal(chrome.element("send").disabled, false);
});

test("a stale presence cannot roll presence backwards", async () => {
  const chrome = await createChromeHarness();

  chrome.sendState({ revision: 7, presence: "working", chat: [] });
  assert.equal(chrome.element("send").disabled, true);

  chrome.sendState({ revision: 5, presence: "listening", chat: [] });
  assert.equal(chrome.element("send").disabled, true);

  chrome.sendState({ revision: 8, presence: "listening", chat: [] });
  assert.equal(chrome.element("send").disabled, false);
});

test("a late snapshot cannot satisfy the next snapshot request", async () => {
  const posts = [];
  const copied = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });
  chrome.element("body").appendChild = () => {};

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Fix the header", selector: "h1", tag: "annotation", text: "Header" },
  });

  // A: a copy request that never gets answered in time.
  chrome.element("copySnapshot").onclick();
  const requestA = chrome.lastSnapshotRequestId();
  chrome.runTimers(2500);
  assert.equal(posts.length, 0);

  // B: a send request that starts before A's answer finally shows up.
  chrome.element("send").onclick();
  const requestB = chrome.lastSnapshotRequestId();
  assert.notEqual(requestA, requestB);

  chrome.answerSnapshot("STALE snapshot from A", requestA);
  await flushPromises();
  // A's late answer must not be treated as B's, nor as a copy of B's page.
  assert.equal(posts.length, 0);
  assert.deepEqual(copied, []);

  chrome.answerSnapshot("fresh snapshot from B", requestB);
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.domSnapshot, "fresh snapshot from B");
});

test("the event stream backoff escalates when a stream opens and dies immediately", async () => {
  // The layout gate's 12s timer would otherwise sit inside the reconnect window being measured.
  const chrome = await createChromeHarness({ sessionData: { ...defaultSessionData, layoutGateEnabled: false } });
  const windows = [];

  for (let cycle = 0; cycle < 5; cycle += 1) {
    const stream = chrome.latestEventSource();
    // Accepted with HTTP 200, then dropped before a single heartbeat - the shape that used to
    // pin every retry to the first-attempt window.
    stream.listeners.get("open")();
    stream.listeners.get("error")();
    const pending = chrome.pendingTimers().filter((timer) => timer.ms >= 500 && timer.ms <= 15_000);
    assert.equal(pending.length, 1);
    windows.push(pending[0].ms);
    chrome.runTimersWhere((timer) => timer.id === pending[0].id);
  }

  // Each window is the capped 2^n range with jitter: 500-1000, 1000-2000, 2000-4000, ...
  assert.ok(windows[1] > windows[0] / 2, `expected escalation, got ${windows}`);
  assert.ok(windows[4] >= 4000, `expected the fifth attempt near the cap, got ${windows}`);
  assert.ok(windows.every((ms) => ms <= 15_000));
});

test("a heartbeat proves the stream healthy and resets the backoff", async () => {
  const chrome = await createChromeHarness({ sessionData: { ...defaultSessionData, layoutGateEnabled: false } });

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const stream = chrome.latestEventSource();
    stream.listeners.get("open")();
    stream.listeners.get("error")();
    const pending = chrome.pendingTimers().filter((timer) => timer.ms >= 500 && timer.ms <= 15_000);
    chrome.runTimersWhere((timer) => timer.id === pending[0].id);
  }

  const healthy = chrome.latestEventSource();
  healthy.listeners.get("open")();
  healthy.listeners.get("heartbeat")({ data: "{}" });
  healthy.listeners.get("error")();

  const pending = chrome.pendingTimers().filter((timer) => timer.ms >= 500 && timer.ms <= 15_000);
  assert.equal(pending.length, 1);
  assert.ok(pending[0].ms <= 1000, `expected a reset first-attempt window, got ${pending[0].ms}`);
});

test("a replacement server re-bases the watermark whatever its revisions look like", async () => {
  for (const replacementRevision of [1, 42, 99]) {
    const chrome = await createChromeHarness();

    chrome.sendState({ bootId: "boot-old", revision: 42, presence: "working", chat: [] });
    assert.equal(chrome.element("send").disabled, true);

    // A different boot id is a different server, full stop. Its counter is unrelated to the old
    // one's, so a lower, equal or higher revision must all be accepted - ordering instances by a
    // number is exactly how a legitimate replacement ends up ignored forever.
    chrome.sendState({ bootId: "boot-new", revision: replacementRevision, presence: "listening", chat: [] });
    assert.equal(chrome.element("send").disabled, false, `replacement revision ${replacementRevision} was ignored`);
  }
});

test("the initial state applies presence, not just chat", async () => {
  const chrome = await createChromeHarness();
  const stream = chrome.latestEventSource();
  stream.listeners.get("open")();

  // Chat and presence share one revision on first connect. Sent as two events under that shared
  // number, the chat was accepted and the presence was rejected for not being newer - so a session
  // that was genuinely working showed an idle, sendable composer.
  chrome.sendState(
    { revision: 3, presence: "working", ended: false, chat: [{ role: "user", text: "kick off some work" }] },
    stream,
  );

  assert.equal(chrome.element("send").disabled, true);
  assert.equal(chrome.element("sendAndEnd").disabled, true);
  assert.match(chrome.element("chatLog").lastAppendedChild.innerHTML, /Working\.\.\./);
  assert.equal(chrome.chatTexts().filter((html) => /kick off some work/.test(html)).length, 1);
});

test("the initial state applies presence even when the chat is empty", async () => {
  const chrome = await createChromeHarness();
  const stream = chrome.latestEventSource();
  stream.listeners.get("open")();

  chrome.sendState({ revision: 0, presence: "working", ended: false, chat: [] }, stream);

  assert.equal(chrome.element("send").disabled, true);
});

test("a stale terminal state cannot end the session after a newer server is accepted", async () => {
  const chrome = await createChromeHarness();

  const first = chrome.latestEventSource();
  first.listeners.get("open")();
  chrome.sendState({ bootId: "boot-old", revision: 5, presence: "listening", chat: [] }, first);

  first.listeners.get("error")();
  chrome.runTimersWhere((timer) => timer.ms >= 500 && timer.ms <= 1000);
  const second = chrome.latestEventSource();
  second.listeners.get("open")();
  chrome.sendState({ bootId: "boot-new", revision: 1, presence: "listening", chat: [] }, second);
  assert.equal(chrome.element("chatInput").disabled, false);

  // The replaced connection now delivers the old server's terminal state. Ending is irreversible,
  // so accepting it from an obsolete generation would permanently close a live session.
  chrome.sendState({ bootId: "boot-old", revision: 99, presence: "waiting", chat: [], ended: true }, first);

  assert.equal(chrome.element("chatInput").disabled, false);
  assert.equal(chrome.element("send").disabled, false);
});

test("a stale state re-check response cannot end the session after reconnecting", async () => {
  let releaseState = () => {};
  const heldState = new Promise((resolve) => {
    releaseState = () => resolve();
  });
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (!String(url).endsWith("/state")) return { ok: true };
      await heldState;
      // The dying server's answer: it believes the session ended.
      return {
        ok: true,
        json: async () => ({ bootId: "boot-old", revision: 99, presence: "waiting", ended: true, chat: [] }),
      };
    },
  });

  const first = chrome.latestEventSource();
  first.listeners.get("open")();
  chrome.sendState({ bootId: "boot-old", revision: 1, presence: "working", chat: [] }, first);
  chrome.runTimers(45_000);

  // The stream is replaced while that re-check is still in flight.
  first.listeners.get("error")();
  chrome.runTimersWhere((timer) => timer.ms >= 500 && timer.ms <= 1000);
  const second = chrome.latestEventSource();
  second.listeners.get("open")();
  chrome.sendState({ bootId: "boot-new", revision: 1, presence: "listening", chat: [] }, second);

  releaseState();
  await flushPromises();
  await flushPromises();

  assert.equal(chrome.element("chatInput").disabled, false);
  assert.equal(chrome.element("send").disabled, false);
});

test("a genuine terminal state from the live connection still ends the session", async () => {
  const chrome = await createChromeHarness();
  const stream = chrome.latestEventSource();
  stream.listeners.get("open")();

  chrome.sendState({ bootId: "boot-1", revision: 2, presence: "listening", chat: [] }, stream);
  chrome.sendState({ bootId: "boot-1", revision: 3, presence: "waiting", chat: [], ended: true }, stream);

  assert.equal(chrome.element("endedOverlay").hidden, false);
  assert.equal(chrome.element("chatInput").disabled, true);
  assert.equal(chrome.element("send").disabled, true);
});
