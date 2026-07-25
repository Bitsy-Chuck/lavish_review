/* global EventSource, document, location, window */

const sessionDataElement = document.getElementById("lavish-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
const key = String(sessionData.key || "");
const filePath = String(sessionData.file || "");
const queueStorageKey = "lavish-axi:queued:" + key;
const internalQueueKeyField = "_lavishQueueKey";
const initialChat = Array.isArray(sessionData.initialChat) ? sessionData.initialChat : [];
const MODE_TOGGLE_HOTKEY_KEY = String(sessionData.modeToggleHotkeyKey || "").toLowerCase();

function isModeToggleHotkeyEvent(event) {
  if (event.shiftKey || event.altKey) return false;
  return Boolean(event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === MODE_TOGGLE_HOTKEY_KEY;
}

const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("artifact"));
const panelScroll = /** @type {HTMLDivElement} */ (document.getElementById("panelScroll"));
const annotationPills = /** @type {HTMLDivElement} */ (document.getElementById("annotationPills"));
const chatLog = /** @type {HTMLDivElement} */ (document.getElementById("chatLog"));
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chatInput"));
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const sendAndEndButton = /** @type {HTMLButtonElement} */ (document.getElementById("sendAndEnd"));
const annotationSwitch = /** @type {HTMLButtonElement} */ (document.getElementById("annotation"));
const moreWrap = /** @type {HTMLDivElement} */ (document.getElementById("moreWrap"));
const moreButton = /** @type {HTMLButtonElement} */ (document.getElementById("moreButton"));
const moreMenu = /** @type {HTMLDivElement} */ (document.getElementById("moreMenu"));
const reloadArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("reloadArtifact"));
const copySnapshotButton = /** @type {HTMLButtonElement} */ (document.getElementById("copySnapshot"));
const exportArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("exportArtifact"));
const shareArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("shareArtifact"));
const shareDialog = /** @type {HTMLDivElement} */ (document.getElementById("shareDialog"));
const shareForm = /** @type {HTMLFormElement} */ (document.getElementById("shareForm"));
const shareCloseButton = /** @type {HTMLButtonElement} */ (document.getElementById("shareClose"));
const shareCancelButton = /** @type {HTMLButtonElement} */ (document.getElementById("shareCancel"));
const sharePublishButton = /** @type {HTMLButtonElement} */ (document.getElementById("sharePublish"));
const sharePasswordInput = /** @type {HTMLInputElement} */ (document.getElementById("sharePassword"));
const shareStatus = /** @type {HTMLDivElement} */ (document.getElementById("shareStatus"));
const shareResult = /** @type {HTMLDivElement} */ (document.getElementById("shareResult"));
const shareUrlInput = /** @type {HTMLInputElement} */ (document.getElementById("shareUrl"));
const shareUpdateKeyInput = /** @type {HTMLInputElement} */ (document.getElementById("shareUpdateKey"));
const copyShareUrlButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyShareUrl"));
const copyUpdateKeyButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyUpdateKey"));
const endButton = /** @type {HTMLButtonElement} */ (document.getElementById("end"));
const copyPathButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyPath"));
const copyHint = /** @type {HTMLSpanElement} */ (document.getElementById("copyHint"));
const copyHintText = /** @type {HTMLSpanElement} */ (document.getElementById("copyHintText"));
const presenceBanner = /** @type {HTMLDivElement} */ (document.getElementById("presenceBanner"));
const endedOverlay = /** @type {HTMLDivElement} */ (document.getElementById("endedOverlay"));
const layoutGateOverlay = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateOverlay"));
const layoutGateTitle = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateTitle"));
const layoutGateCopy = /** @type {HTMLParagraphElement} */ (document.getElementById("layoutGateCopy"));
const layoutGateAction = /** @type {HTMLButtonElement} */ (document.getElementById("layoutGateAction"));
const layoutIssueBanner = /** @type {HTMLDivElement} */ (document.getElementById("layoutIssueBanner"));
const sendHint = /** @type {HTMLDivElement} */ (document.getElementById("sendHint"));
const connectionBanner = /** @type {HTMLDivElement} */ (document.getElementById("connectionBanner"));
const submitError = /** @type {HTMLDivElement} */ (document.getElementById("submitError"));
const submitErrorText = /** @type {HTMLSpanElement} */ (document.getElementById("submitErrorText"));
const submitRetryButton = /** @type {HTMLButtonElement} */ (document.getElementById("submitRetry"));
const whiteboardOverlay = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardOverlay"));
const whiteboardFrame = /** @type {HTMLIFrameElement} */ (document.getElementById("whiteboardFrame"));
const whiteboardCloseButton = /** @type {HTMLButtonElement} */ (document.getElementById("whiteboardClose"));
const whiteboardError = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardError"));
const artifactSrc = frame.dataset.artifactSrc || frame.getAttribute?.("data-artifact-src") || frame.src || "";

const queued = loadQueuedPrompts();
let annotation = true;
let ended = false;
let agentPresence = "waiting";
let pendingSnapshot = "";
const layoutGateEnabled = sessionData.layoutGateEnabled !== false;
const configuredLayoutGateMaxHoldMs = Number(sessionData.layoutGateMaxHoldMs);
const layoutGateMaxHoldMs =
  Number.isFinite(configuredLayoutGateMaxHoldMs) && configuredLayoutGateMaxHoldMs > 0
    ? Math.min(configuredLayoutGateMaxHoldMs, 60_000)
    : 12_000;
let layoutGateVisible = false;
let layoutGateArmed = false;
let layoutGateManuallyBypassed = !layoutGateEnabled;
let layoutGateCycle = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let layoutGateTimer;
const snapshotRequests = [];
let endAfterSubmit = false;
let workingBubble = null;
let submitQueuedPromise = null;
let submitQueuedAgain = false;
let lastScroll = { x: 0, y: 0 };
/** @type {ReturnType<typeof setTimeout> | undefined} */
let copyHintTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendHintTimer;

const DEFAULT_SEND_HINT_TEXT = "Write a message or annotate an element first.";
// The artifact answers snapshot requests over postMessage. If its own JS threw before the SDK
// registered that listener the answer never arrives, so every request is bounded and falls back to
// sending without a snapshot instead of leaving the click with no effect at all.
const SNAPSHOT_TIMEOUT_MS = 2_500;
// How long an unchanged "working" presence is trusted before the composer unlocks itself. The
// server latches presence at "working" as soon as an agent takes delivery and stops polling, and
// that latch outlives a page reload, so the escape hatch has to live here.
const PRESENCE_STALL_MS = 45_000;
const SSE_RECONNECT_BASE_MS = 1_000;
const SSE_RECONNECT_MAX_MS = 15_000;
// The server heartbeats every 15s. Missing three in a row means the stream is dead even when
// EventSource never fired an error, which is exactly how a half-open proxied connection behaves.
const SSE_HEARTBEAT_TIMEOUT_MS = 50_000;

/** @type {EventSource | null} */
let eventStream = null;
let eventStreamConnected = false;
let eventStreamEverOpened = false;
let eventStreamAttempt = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let eventStreamReconnectTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let eventStreamWatchdogTimer;
/** @type {Promise<void> | null} */
let resyncPromise = null;
let presenceStalled = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let presenceStallTimer;
let pendingComposerPrompt = null;
let pendingComposerText = "";
let pendingUserBubble = null;
let lastSendEndAfter = false;
/** @type {(() => void) | null} */
let submitRetryAction = null;

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function loadQueuedPrompts() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(queueStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter((prompt) => prompt && typeof prompt === "object") : [];
  } catch {
    return [];
  }
}

function persistQueuedPrompts() {
  try {
    if (queued.length) {
      sessionStorage.setItem(queueStorageKey, JSON.stringify(queued));
    } else {
      sessionStorage.removeItem(queueStorageKey);
    }
  } catch {
    // The in-memory queue still works if browser storage is unavailable.
  }
}

function render() {
  annotationPills.innerHTML = queued.map(renderQueuedPill).join("");

  for (const button of annotationPills.querySelectorAll(".pill-close")) {
    const closeButton = /** @type {HTMLButtonElement} */ (button);
    closeButton.addEventListener("click", (event) => removeQueuedPrompt(Number(closeButton.dataset.index), event));
  }
  updateSendState();
  scrollPanelToBottom();
}

// Keeps the pill index aligned with `queued` even for entries that render as nothing.
function renderQueuedPill(prompt, index) {
  // The freeform message behind an in-flight send still sits in the composer until the POST
  // succeeds, so rendering it as a pill too would show the same text three times over.
  if (prompt === pendingComposerPrompt) return "";
  return (
    '<div class="pill-wrap"><div class="pill"><span class="pill-preview">' +
    escapeHtml(prompt.prompt) +
    '</span><button class="pill-close" type="button" aria-label="Remove queued prompt" data-index="' +
    index +
    '"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><div class="pill-tooltip">' +
    (prompt.selector
      ? '<div class="tooltip-label">Target</div><div class="pill-tooltip-target">' +
        escapeHtml(prompt.selector) +
        "</div>"
      : "") +
    '<div class="tooltip-label">Prompt</div><div class="pill-tooltip-prompt">' +
    escapeHtml(prompt.prompt) +
    "</div></div></div>"
  );
}

function updateSendState() {
  // `presenceStalled` is the escape hatch: server presence can stay latched at "working" forever
  // once an agent takes delivery and never polls again, and that must not mute the composer.
  sendButton.disabled = ended || (agentPresence === "working" && !presenceStalled);
  sendAndEndButton.disabled = sendButton.disabled;
}

function setSendHint(text) {
  sendHint.textContent = text;
  sendHint.hidden = false;
  clearTimeout(sendHintTimer);
  sendHintTimer = setTimeout(() => {
    sendHint.hidden = true;
  }, 2600);
}

function showSendHint() {
  setSendHint(DEFAULT_SEND_HINT_TEXT);
  chatInput.focus();
}

// Transient notice in the composer for a degraded-but-completed action, as opposed to the
// failure box, which sticks around and offers a retry.
function showComposerNotice(message) {
  setSendHint(message);
}

function showSubmitError(message, retry) {
  submitErrorText.textContent = message;
  submitRetryButton.hidden = !retry;
  submitRetryAction = retry || null;
  submitError.hidden = false;
}

function hideSubmitError() {
  submitError.hidden = true;
  submitRetryAction = null;
}

function setConnectionBanner(visible) {
  connectionBanner.hidden = !visible || ended;
}

function hideSendHint() {
  clearTimeout(sendHintTimer);
  sendHint.hidden = true;
}

function setMenuOpen(button, menu, open) {
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function closeMenus() {
  setMenuOpen(moreButton, moreMenu, false);
}

function toggleMenu(button, menu) {
  const open = menu.hidden;
  closeMenus();
  setMenuOpen(button, menu, open);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea-based fallback below.
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  document.execCommand("copy");
  helper.remove();
  return true;
}

function addChat(role, text, shouldScroll = true) {
  if (!text) return;

  const el = document.createElement("div");
  el.className = "bubble " + role;
  el.innerHTML = "<small>" + (role === "agent" ? "Agent" : "You") + "</small><div>" + escapeHtml(text) + "</div>";
  chatLog.appendChild(el);
  if (shouldScroll) scrollElementIntoView(el);
  return el;
}

function syncChat(chat) {
  for (const el of [...chatLog.querySelectorAll(".bubble.user,.bubble.agent:not(.agent-working)")]) {
    el.remove();
  }

  let lastChatBubble = null;
  for (const item of chat) lastChatBubble = addChat(item.role, item.text, false) || lastChatBubble;
  // The optimistic bubble for an in-flight send is not in the server's chat yet. Re-append it so a
  // sync landing mid-submit does not make the user's own message vanish before it is even sent.
  if (pendingUserBubble) {
    chatLog.appendChild(pendingUserBubble);
    lastChatBubble = pendingUserBubble;
  }
  if (workingBubble) {
    chatLog.appendChild(workingBubble);
    scrollElementIntoView(workingBubble);
  } else if (lastChatBubble) {
    scrollElementIntoView(lastChatBubble);
  }
}

function setAgentPresence(state) {
  const next = state === "listening" || state === "working" ? state : "waiting";
  const changed = next !== agentPresence;
  agentPresence = next;

  if (agentPresence !== "working") {
    clearPresenceStall();
  } else if (changed) {
    // A fresh transition into "working" is real news from the server, so trust it again.
    armPresenceStall();
  }

  updateSendState();
  if (presenceBanner) presenceBanner.hidden = ended || agentPresence !== "waiting";

  if (agentPresence !== "working") {
    if (workingBubble) workingBubble.remove();
    workingBubble = null;
    return;
  }

  if (!workingBubble) {
    workingBubble = document.createElement("div");
    workingBubble.className = "bubble agent agent-working";
    workingBubble.innerHTML = '<span class="spinner"></span><span>Working...</span>';
    chatLog.appendChild(workingBubble);
    if (presenceStalled) markWorkingBubbleStalled();
  }
  scrollElementIntoView(workingBubble);
}

function armPresenceStall() {
  clearTimeout(presenceStallTimer);
  presenceStalled = false;
  presenceStallTimer = setTimeout(handlePresenceStall, PRESENCE_STALL_MS);
}

function clearPresenceStall() {
  clearTimeout(presenceStallTimer);
  presenceStallTimer = undefined;
  presenceStalled = false;
}

function handlePresenceStall() {
  presenceStallTimer = undefined;
  if (ended || agentPresence !== "working") return;
  presenceStalled = true;
  markWorkingBubbleStalled();
  updateSendState();
  // Ask the server before settling on the pessimistic story - the stall may just be a stream that
  // dropped the presence event that would have cleared it.
  resyncState().catch(() => {});
}

// A stalled agent must never keep showing the same spinner as a working one.
function markWorkingBubbleStalled() {
  if (!workingBubble) return;
  workingBubble.classList.add("agent-stalled");
  workingBubble.innerHTML =
    '<span class="spinner"></span><span>No word from your agent for a while. It may have stopped listening - you can send again, and it will be delivered the next time the agent checks in.</span>';
}

function scrollPanelToBottom() {
  panelScroll.scrollTop = panelScroll.scrollHeight;
}

function scrollElementIntoView(el) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function removeQueuedPrompt(index, event) {
  if (event) event.stopPropagation();
  queued.splice(index, 1);
  persistQueuedPrompts();
  render();
}

function promptQueueKey(prompt) {
  return prompt && typeof prompt[internalQueueKeyField] === "string" ? prompt[internalQueueKeyField].trim() : "";
}

function enqueuePrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return;

  const queueKey = promptQueueKey(prompt);
  if (queueKey) {
    const index = queued.findIndex((item) => promptQueueKey(item) === queueKey);
    if (index !== -1) {
      queued[index] = prompt;
    } else {
      queued.push(prompt);
    }
  } else {
    queued.push(prompt);
  }

  persistQueuedPrompts();
  render();
}

function stripInternalPromptFields(prompt) {
  if (!prompt || typeof prompt !== "object") return prompt;
  const clean = { ...prompt };
  delete clean[internalQueueKeyField];
  return clean;
}

function postToFrame(message) {
  if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
}

function requestSnapshot(action) {
  const request = { action, settled: false, timer: undefined };
  request.timer = setTimeout(() => handleSnapshotTimeout(request), SNAPSHOT_TIMEOUT_MS);
  snapshotRequests.push(request);
  postToFrame({ type: "lavish:requestSnapshot" });
}

function takeSnapshotRequest() {
  const request = snapshotRequests.shift();
  if (!request) return null;
  request.settled = true;
  clearTimeout(request.timer);
  return request;
}

function handleSnapshotTimeout(request) {
  if (request.settled) return;
  request.settled = true;
  const index = snapshotRequests.indexOf(request);
  if (index !== -1) snapshotRequests.splice(index, 1);

  if (request.action === "copy") {
    showComposerNotice("The artifact did not answer with a DOM snapshot. Reload the artifact and try again.");
    return;
  }
  // Degraded send: the agent gets the feedback without a DOM snapshot, which beats a Send button
  // that silently does nothing because the artifact's own JS threw before the SDK loaded.
  pendingSnapshot = "";
  showComposerNotice("The artifact did not respond, so this was sent without a page snapshot.");
  submitQueued().catch(() => {});
}

function sendQueued(endAfter) {
  if (ended || (agentPresence === "working" && !presenceStalled)) return;
  closeMenus();
  hideSubmitError();

  // While a composer send is already in flight its text stays in the box, so re-reading it here
  // would queue the same message twice.
  const text = pendingComposerPrompt ? "" : chatInput.value.trim();
  if (text) {
    pendingComposerText = text;
    pendingComposerPrompt = { uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message" };
    queued.push(pendingComposerPrompt);
    persistQueuedPrompts();
    pendingUserBubble = addChat("user", text) || null;
    if (pendingUserBubble) pendingUserBubble.classList.add("pending");
    render();
  }
  if (!queued.length) {
    showSendHint();
    return;
  }
  hideSendHint();

  lastSendEndAfter = Boolean(endAfter);
  if (endAfter) endAfterSubmit = true;
  requestSnapshot("submit");
}

// The composer only loses the user's text once the server has it.
function commitPendingComposer() {
  if (!pendingComposerPrompt) return;
  if (chatInput.value.trim() === pendingComposerText) chatInput.value = "";
  if (pendingUserBubble) pendingUserBubble.classList.remove("pending");
  pendingComposerPrompt = null;
  pendingComposerText = "";
  pendingUserBubble = null;
}

// ...and gets it back, along with its bubble, if the send failed.
function rollbackPendingComposer() {
  if (pendingComposerPrompt) {
    const index = queued.indexOf(pendingComposerPrompt);
    if (index !== -1) queued.splice(index, 1);
    persistQueuedPrompts();
  }
  if (pendingUserBubble) pendingUserBubble.remove();
  if (pendingComposerText && !chatInput.value.trim()) chatInput.value = pendingComposerText;
  pendingComposerPrompt = null;
  pendingComposerText = "";
  pendingUserBubble = null;
  render();
}

function handleSubmitFailure() {
  rollbackPendingComposer();
  showSubmitError("Could not reach Lavish, so nothing was sent.", () => sendQueued(lastSendEndAfter));
}

function handleEndSessionFailure() {
  showSubmitError("Could not reach Lavish to end this session.", () => {
    endSession().catch(handleEndSessionFailure);
  });
}

async function submitQueued() {
  if (submitQueuedPromise) {
    submitQueuedAgain = true;
    return submitQueuedPromise;
  }

  let succeeded = false;
  submitQueuedPromise = submitQueuedOnce();
  try {
    const result = await submitQueuedPromise;
    succeeded = true;
    return result;
  } finally {
    submitQueuedPromise = null;
    const shouldSubmitAgain = submitQueuedAgain;
    submitQueuedAgain = false;
    if (!succeeded) {
      endAfterSubmit = false;
      handleSubmitFailure();
    } else if (!ended && shouldSubmitAgain) {
      if (queued.length) {
        submitQueued().catch(() => {});
      } else if (endAfterSubmit) {
        endAfterSubmit = false;
        endSession().catch(handleEndSessionFailure);
      }
    }
  }
}

async function submitQueuedOnce() {
  const prompts = queued.slice();
  const shouldEndSession = endAfterSubmit;
  const body = { prompts: prompts.map(stripInternalPromptFields), domSnapshot: pendingSnapshot };
  if (shouldEndSession) body.endSession = true;
  const response = await fetch("/api/" + key + "/prompts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("failed to submit queued prompts");
  for (const prompt of prompts) {
    const index = queued.indexOf(prompt);
    if (index !== -1) queued.splice(index, 1);
  }
  persistQueuedPrompts();
  commitPendingComposer();
  hideSubmitError();
  render();
  if (shouldEndSession) {
    endAfterSubmit = false;
    markSessionEnded();
    return;
  }
  if (agentPresence === "listening") setAgentPresence("working");
}

function normalizeLayoutWarningsPayload(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function isErrorLayoutWarning(warning) {
  return String(warning?.severity || "").toLowerCase() === "error";
}

function setLayoutIssueBanner(visible, text = "This surface may have layout issues. Your agent has been notified.") {
  if (!layoutIssueBanner) return;
  layoutIssueBanner.textContent = text;
  layoutIssueBanner.hidden = !visible;
}

function clearLayoutGateTimer() {
  if (layoutGateTimer) clearTimeout(layoutGateTimer);
  layoutGateTimer = undefined;
}

function setLayoutGateCard(state) {
  if (!layoutGateTitle || !layoutGateCopy) return;

  if (state === "held") {
    layoutGateTitle.innerHTML = "Fixing a layout issue...";
    layoutGateCopy.textContent =
      "The real browser found overflow or overlapping content. Your agent has been notified and this will reveal after the next clean reload.";
    return;
  }

  layoutGateTitle.innerHTML = "Checking layout.<br>One moment.";
  layoutGateCopy.textContent = "Lavish is waiting for fonts and final geometry before revealing this artifact.";
}

function setLayoutGateActive(active) {
  layoutGateVisible = active;
  if (layoutGateOverlay) layoutGateOverlay.hidden = !active;
  document.body?.classList?.toggle("layout-gate-active", active);
}

function revealLayoutGate({ showBanner = false, bannerText = undefined } = {}) {
  clearLayoutGateTimer();
  layoutGateArmed = false;
  setLayoutGateActive(false);
  setLayoutIssueBanner(showBanner, bannerText);
}

function forceRevealLayoutGate(reason) {
  if (!layoutGateEnabled || ended) return;
  if (reason === "manual") layoutGateManuallyBypassed = true;
  const bannerText =
    reason === "timeout"
      ? "This surface may have layout issues. Lavish revealed it after the safety timeout so review is never blocked."
      : "This surface may have layout issues. You chose to show it before the layout check passed.";
  revealLayoutGate({ showBanner: true, bannerText });
}

function startLayoutGateCycle() {
  if (!layoutGateEnabled || layoutGateManuallyBypassed || ended) return;

  layoutGateCycle += 1;
  layoutGateArmed = true;
  setLayoutIssueBanner(false);
  setLayoutGateCard("checking");
  setLayoutGateActive(true);
  clearLayoutGateTimer();

  const cycle = layoutGateCycle;
  layoutGateTimer = setTimeout(() => {
    if (cycle !== layoutGateCycle || !layoutGateVisible || ended) return;
    forceRevealLayoutGate("timeout");
  }, layoutGateMaxHoldMs);
  layoutGateTimer?.unref?.();
}

function handleLayoutWarningsForGate(layoutWarnings) {
  const warnings = normalizeLayoutWarningsPayload(layoutWarnings);
  const hasErrors = warnings.some(isErrorLayoutWarning);

  if (!layoutGateEnabled) return;

  if (layoutGateManuallyBypassed) {
    setLayoutIssueBanner(hasErrors);
    return;
  }

  if (!layoutGateArmed && !layoutGateVisible) return;

  if (!hasErrors) {
    revealLayoutGate();
    return;
  }

  setLayoutGateCard("held");
  setLayoutGateActive(true);
}

function initializeLayoutGate() {
  if (!layoutGateEnabled) {
    setLayoutGateActive(false);
    setLayoutIssueBanner(false);
    return;
  }

  if (layoutGateAction) layoutGateAction.onclick = () => forceRevealLayoutGate("manual");
  startLayoutGateCycle();
}

async function submitLayoutWarnings(layoutWarnings) {
  const response = await fetch("/api/" + key + "/layout-warnings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout_warnings: normalizeLayoutWarningsPayload(layoutWarnings) }),
  });
  if (!response.ok) throw new Error("failed to submit layout warnings");
}

async function endSession() {
  if (ended) return;
  const response = await fetch("/api/" + key + "/end", { method: "POST" });
  if (!response.ok) throw new Error("failed to end session");
  markSessionEnded();
}

function markSessionEnded() {
  if (ended) return;
  ended = true;
  clearPresenceStall();
  hideSubmitError();
  stopEventStream();
  setConnectionBanner(false);
  closeMenus();
  closeWhiteboard();
  annotationSwitch.disabled = true;
  moreButton.disabled = true;
  chatInput.disabled = true;
  updateSendState();
  if (presenceBanner) presenceBanner.hidden = true;
  layoutGateManuallyBypassed = true;
  revealLayoutGate();
  postToFrame({ type: "lavish:setAnnotationMode", enabled: false });
  endedOverlay.hidden = false;
}

function copyFilePath() {
  copyText(filePath);
  copyHint.classList.add("copied");
  copyHintText.textContent = "Copied";
  clearTimeout(copyHintTimer);
  copyHintTimer = setTimeout(() => {
    copyHint.classList.remove("copied");
    copyHintText.textContent = "Copy";
  }, 1600);
}

function copyDomSnapshot() {
  closeMenus();
  requestSnapshot("copy");
}

function exportFileName() {
  const base = (filePath.split(/[\\/]/).pop() || "artifact.html").replace(/\.html?$/i, "");
  return (base || "artifact") + ".export.html";
}

function setExportLabel(text) {
  const label = exportArtifactButton.querySelector("span");
  if (label) label.textContent = text;
}

function unresolvedAssetText(count) {
  return count === 1 ? "1 unresolved asset" : `${count} unresolved assets`;
}

function noticeText(count) {
  return count === 1 ? "1 notice" : `${count} notices`;
}

function exportWarningText(unresolvedCount, noticeCount) {
  if (unresolvedCount > 0 && noticeCount > 0) {
    return `${unresolvedAssetText(unresolvedCount)} and ${noticeText(noticeCount)}`;
  }
  if (unresolvedCount > 0) return unresolvedAssetText(unresolvedCount);
  return noticeText(noticeCount);
}

async function exportArtifact() {
  // The bundle inlines local assets server-side, so it can take a moment - keep the menu open
  // and narrate progress in place instead of closing it and leaving the user with no feedback.
  exportArtifactButton.disabled = true;
  setExportLabel("Exporting...");
  try {
    const response = await fetch("/api/" + key + "/export");
    if (!response.ok) throw new Error("export failed");
    const warningCount = Number(response.headers.get("x-lavish-export-warning-count") || "0");
    const noticeCount = Number(response.headers.get("x-lavish-export-notice-count") || "0");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (warningCount > 0 || noticeCount > 0) {
      setExportLabel(`Exported with ${exportWarningText(warningCount, noticeCount)}`);
    } else {
      setExportLabel("Export standalone HTML");
      closeMenus();
    }
  } catch {
    setExportLabel("Export failed - retry");
  } finally {
    exportArtifactButton.disabled = false;
  }
}

function openShareDialog() {
  closeMenus();
  shareDialog.hidden = false;
  shareStatus.textContent = "";
  shareStatus.classList.remove("error");
  shareResult.hidden = true;
  sharePasswordInput.value = "";
  sharePasswordInput.focus();
}

function closeShareDialog() {
  shareDialog.hidden = true;
}

async function copyToButton(value, button, label) {
  await copyText(value);
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = label;
  }, 1200);
}

async function publishShare(event) {
  event.preventDefault();
  sharePublishButton.disabled = true;
  shareStatus.classList.remove("error");
  shareStatus.textContent = "Publishing to ht-ml.app...";
  shareResult.hidden = true;
  const password = sharePasswordInput.value.trim();
  const passwordProtected = Boolean(password);
  try {
    const response = await fetch("/api/" + key + "/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(password ? { password } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "publish failed");
    shareUrlInput.value = data.url || "";
    shareUpdateKeyInput.value = data.update_key || "";
    const unresolvedAssets = Array.isArray(data.unresolved_local_assets) ? data.unresolved_local_assets : [];
    const notices = Array.isArray(data.notices) ? data.notices : [];
    const warningCount = unresolvedAssets.length;
    const noticeCount = notices.length;
    const noticeSummary = noticeCount ? noticeText(noticeCount) : "";
    shareStatus.textContent =
      warningCount > 0
        ? `Published with ${warningCount === 1 ? "1 unresolved local asset" : `${warningCount} unresolved local assets`}${noticeSummary ? ` and ${noticeSummary}` : ""}.${passwordProtected ? " This page is PASSWORD-PROTECTED; viewers also need the password." : ""}`
        : noticeCount > 0
          ? `Published with ${noticeSummary}.${passwordProtected ? " This page is PASSWORD-PROTECTED; viewers also need the password." : ""}`
          : passwordProtected
            ? "Published. This page is PASSWORD-PROTECTED; viewers also need the password."
            : "Published. Anyone with the link can view this page.";
    shareResult.hidden = false;
    shareUrlInput.focus();
    shareUrlInput.select();
  } catch (error) {
    shareStatus.classList.add("error");
    shareStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    sharePublishButton.disabled = false;
  }
}

function replaceArtifactFrame() {
  startLayoutGateCycle();
  inlineWhiteboardChannels.clear();
  // The iframe is sandboxed, so reload by resetting the iframe URL from chrome.
  frame.src = artifactSrc || frame.src;
}

function resetFrame() {
  if (artifactResetPromise) return artifactResetPromise;
  const hasLiveInlineWhiteboard = [...inlineWhiteboardChannels].some(
    ([index, channel]) => channel.initialized && index !== overlayIndex,
  );
  if (!hasLiveInlineWhiteboard) {
    replaceArtifactFrame();
    return Promise.resolve(true);
  }
  artifactResetPromise = flushInlineWhiteboards()
    .then((flushed) => {
      if (!flushed) return false;
      replaceArtifactFrame();
      return true;
    })
    .finally(() => {
      artifactResetPromise = null;
    });
  return artifactResetPromise;
}

// ---------------------------------------------------------------------------
// Whiteboards. The artifact SDK embeds one sandboxed whiteboard frame in place
// of each rendered Mermaid diagram. The chrome owns every server round trip
// and serves all frames concurrently. The overlay hosts the same frame page
// fullscreen when an inline frame asks to maximize - the inline frame is
// suspended while the overlay owns that diagram so two editors never autosave
// one sidecar.
// ---------------------------------------------------------------------------

/** @type {Map<number, { diagramId: string, source: string, sourceHash: string }>} */
const whiteboards = new Map();
/** @type {number | null} */
let overlayIndex = null;
let overlayFrameReady = false;
let overlayChannelId = "";
let overlayOpeningIndex = null;
let nextWhiteboardFlushId = 0;
let artifactResetPromise = null;
let chromeRestartReloadPromise = null;
const whiteboardTeardowns = new Map();
const whiteboardFlushes = new Map();
const whiteboardSaveChains = new Map();
const inlineWhiteboardChannels = new Map();

function whiteboardTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function postToWhiteboardOverlay(message) {
  if (whiteboardFrame.contentWindow && overlayChannelId) {
    whiteboardFrame.contentWindow.postMessage({ ...message, channelId: overlayChannelId }, "*");
  }
}

function postToInlineWhiteboard(index, message) {
  const channel = inlineWhiteboardChannels.get(index);
  if (channel?.window) channel.window.postMessage({ ...message, channelId: channel.channelId }, "*");
}

function postToWhiteboard(index, placement, message) {
  if (placement === "overlay") postToWhiteboardOverlay(message);
  else postToInlineWhiteboard(index, message);
}

async function fetchMermaidSources() {
  const response = await fetch("/api/" + key + "/mermaid-sources");
  if (!response.ok) throw new Error("could not read the artifact's Mermaid sources");
  const data = await response.json();
  return Array.isArray(data.sources) ? data.sources : [];
}

async function authenticateWhiteboardChannel(token) {
  const response = await fetch("/api/" + key + "/whiteboard-channel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return response.ok;
}

function showWhiteboardError(text) {
  whiteboardError.textContent = text;
  whiteboardError.hidden = false;
  whiteboardOverlay.hidden = false;
}

function whiteboardRecord(index) {
  let record = whiteboards.get(index);
  if (!record) {
    record = { diagramId: "", source: "", sourceHash: "" };
    whiteboards.set(index, record);
  }
  return record;
}

async function handleWhiteboardReady(index, mode, isCurrent) {
  try {
    const sources = await fetchMermaidSources();
    const source = sources.find((item) => item.index === index);
    if (!source) throw new Error("this diagram's Mermaid source was not found in the artifact file");
    const savedResponse = await fetch("/api/" + key + "/whiteboard/" + index);
    const saved = savedResponse.ok ? (await savedResponse.json()).whiteboard : null;
    const record = whiteboardRecord(index);
    record.source = String(source.source || "");
    record.sourceHash = String(source.hash || "");
    if (!isCurrent()) return false;
    postToWhiteboard(index, mode, {
      type: "lavish-whiteboard:init",
      mode,
      diagramIndex: index,
      diagramId: record.diagramId,
      source: record.source,
      sourceHash: record.sourceHash,
      saved,
      theme: whiteboardTheme(),
    });
    return true;
  } catch (error) {
    if (mode === "overlay") {
      showWhiteboardError("Could not open the whiteboard: " + (error instanceof Error ? error.message : String(error)));
    }
    return false;
  }
}

function showWhiteboardOverlay(index) {
  if (ended) return;
  overlayIndex = index;
  overlayFrameReady = false;
  overlayChannelId = "";
  inlineWhiteboardChannels.delete(index);
  whiteboardError.hidden = true;
  whiteboardOverlay.hidden = false;
  postToFrame({ type: "lavish:suspendWhiteboard", diagramIndex: index });
  // A fresh document per open: the frame boots, posts ready, and receives its
  // init - no stale editor state can leak between opens.
  whiteboardFrame.src = "/whiteboard-frame?diagramIndex=" + encodeURIComponent(String(index));
}

function finishWhiteboardClose(index) {
  whiteboardOverlay.hidden = true;
  whiteboardError.hidden = true;
  whiteboardFrame.src = "about:blank";
  overlayIndex = null;
  overlayFrameReady = false;
  overlayChannelId = "";
  inlineWhiteboardChannels.delete(index);
  if (!ended) postToFrame({ type: "lavish:resumeWhiteboard", diagramIndex: index });
}

function whiteboardTeardownKey(index, placement) {
  return placement + ":" + index;
}

function beginWhiteboardTeardown(index, placement, onComplete) {
  const key = whiteboardTeardownKey(index, placement);
  const pending = whiteboardTeardowns.get(key);
  if (pending) {
    if (onComplete) pending.promise.then(onComplete);
    return pending.promise;
  }
  const flushId = `whiteboard-${++nextWhiteboardFlushId}`;
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  const teardown = { index, placement, flushId, promise, resolve, onComplete };
  whiteboardTeardowns.set(key, teardown);
  const message = { type: "lavish-whiteboard:prepareTeardown", flushId };
  postToWhiteboard(index, placement, message);
  return promise;
}

function finishWhiteboardTeardown(index, message, placement) {
  const flushId = String(message.flushId || "");
  const key = whiteboardTeardownKey(index, placement);
  const teardown = whiteboardTeardowns.get(key);
  if (!teardown || teardown.index !== index || teardown.placement !== placement || teardown.flushId !== flushId) return;
  whiteboardTeardowns.delete(key);
  teardown.onComplete?.(true);
  teardown.resolve(true);
}

function failWhiteboardTeardown(index, message, placement) {
  const flushId = String(message.flushId || "");
  const key = whiteboardTeardownKey(index, placement);
  const teardown = whiteboardTeardowns.get(key);
  if (!teardown || teardown.index !== index || teardown.placement !== placement || teardown.flushId !== flushId) return;
  whiteboardTeardowns.delete(key);
  teardown.onComplete?.(false);
  teardown.resolve(false);
}

function whiteboardFlushKey(index, placement) {
  return placement + ":" + index;
}

function beginWhiteboardFlush(index, placement) {
  const flushKey = whiteboardFlushKey(index, placement);
  const pending = whiteboardFlushes.get(flushKey);
  if (pending) return pending.promise;
  const flushId = `whiteboard-flush-${++nextWhiteboardFlushId}`;
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  whiteboardFlushes.set(flushKey, { index, placement, flushId, promise, resolve });
  postToWhiteboard(index, placement, { type: "lavish-whiteboard:flush", flushId });
  return promise;
}

function finishWhiteboardFlush(index, message, placement) {
  const flushId = String(message.flushId || "");
  const flushKey = whiteboardFlushKey(index, placement);
  const flush = whiteboardFlushes.get(flushKey);
  if (!flush || flush.index !== index || flush.placement !== placement || flush.flushId !== flushId) return;
  whiteboardFlushes.delete(flushKey);
  flush.resolve(Boolean(message.ok));
}

async function flushWhiteboardsBeforeChromeReload() {
  const flushes = [];
  for (const [index, channel] of inlineWhiteboardChannels) {
    if (channel.initialized && index !== overlayIndex) flushes.push(beginWhiteboardFlush(index, "inline"));
  }
  if (overlayIndex !== null && overlayFrameReady) flushes.push(beginWhiteboardFlush(overlayIndex, "overlay"));
  if (flushes.length === 0) return;
  let timeout;
  await Promise.race([
    Promise.all(flushes),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, 1500);
    }),
  ]);
  clearTimeout(timeout);
}

async function flushInlineWhiteboards() {
  for (const [index, channel] of [...inlineWhiteboardChannels]) {
    if (!channel.initialized || index === overlayIndex) continue;
    if (!(await beginWhiteboardTeardown(index, "inline"))) return false;
  }
  return true;
}

function openWhiteboardOverlay(index) {
  if (ended || overlayIndex !== null || overlayOpeningIndex !== null) return;
  overlayOpeningIndex = index;
  beginWhiteboardTeardown(index, "inline", (flushed) => {
    if (overlayOpeningIndex !== index) return;
    overlayOpeningIndex = null;
    if (flushed && !ended && overlayIndex === null) showWhiteboardOverlay(index);
  });
}

function closeWhiteboard() {
  const index = overlayIndex;
  if (index === null) return;
  if (!overlayFrameReady) {
    finishWhiteboardClose(index);
    return;
  }
  beginWhiteboardTeardown(index, "overlay", (flushed) => {
    if (flushed && overlayIndex === index) finishWhiteboardClose(index);
  });
}

async function persistWhiteboardScene(index, message) {
  const response = await fetch("/api/" + key + "/whiteboard/" + index, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source_hash: String(message.sourceHash || ""),
      scene: message.scene || null,
      baseline: message.baseline || null,
    }),
  });
  if (!response.ok) throw new Error("failed to save whiteboard scene");
}

function saveWhiteboardScene(index, message) {
  const previous = whiteboardSaveChains.get(index) || Promise.resolve();
  const result = previous.catch(() => {}).then(() => persistWhiteboardScene(index, message));
  const tail = result.catch(() => {});
  whiteboardSaveChains.set(index, tail);
  tail.finally(() => {
    if (whiteboardSaveChains.get(index) === tail) whiteboardSaveChains.delete(index);
  });
  return result;
}

function handleWhiteboardSave(index, message, mode) {
  const flushId = String(message.flushId || "");
  saveWhiteboardScene(index, message).then(
    () => {
      if (flushId) postToWhiteboard(index, mode, { type: "lavish-whiteboard:saveResult", flushId, ok: true });
    },
    (error) => {
      if (flushId) {
        postToWhiteboard(index, mode, {
          type: "lavish-whiteboard:saveResult",
          flushId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

function whiteboardSummaryText(summaryLines) {
  return (Array.isArray(summaryLines) ? summaryLines : [])
    .filter((line) => typeof line === "string")
    .slice(0, 50)
    .map((line) => line.slice(0, 300))
    .join("\n");
}

async function queueWhiteboardFeedback(index, message, mode) {
  const diagramId = whiteboardRecord(index).diagramId;
  try {
    // Persist the exact reviewed state before queueing, so the paths in the
    // prompt point at what the user actually saw.
    await saveWhiteboardScene(index, message);
    const response = await fetch("/api/" + key + "/whiteboard/" + index + "/feedback-files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene: message.scene || null, pngDataUrl: String(message.pngDataUrl || "") }),
    });
    if (!response.ok) throw new Error("failed to write whiteboard feedback files");
    const files = await response.json();
    const note = String(message.note || "").slice(0, 4000);
    const summary = whiteboardSummaryText(message.summaryLines);
    const promptText =
      (note ? note + "\n\n" : "") +
      "Whiteboard edits to diagram " +
      (index + 1) +
      (diagramId ? " (" + diagramId + ")" : "") +
      ":\n" +
      (summary || "(no summary)") +
      "\n\nEdited scene JSON: " +
      String(files.scene_path || "") +
      (files.preview_path ? "\nPNG preview: " + String(files.preview_path) : "");
    enqueuePrompt({
      uid: "",
      prompt: promptText,
      selector: "",
      tag: "whiteboard",
      text: "Whiteboard: diagram " + (index + 1),
      target: {
        type: "excalidraw-scene",
        diagramIndex: index,
        diagramId,
        sourceHash: String(message.sourceHash || ""),
        scenePath: String(files.scene_path || ""),
        previewPath: String(files.preview_path || ""),
        imageFallback: Boolean(message.imageFallback),
        stats: message.stats && typeof message.stats === "object" ? message.stats : {},
      },
      // Re-queueing the same diagram's whiteboard before sending replaces the
      // earlier unsent prompt instead of stacking duplicates.
      [internalQueueKeyField]: "whiteboard:" + index,
    });
    postToWhiteboard(index, mode, { type: "lavish-whiteboard:queueResult", ok: true });
    if (mode === "overlay") closeWhiteboard();
  } catch (error) {
    postToWhiteboard(index, mode, {
      type: "lavish-whiteboard:queueResult",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Inline frames live inside the artifact iframe, so a live reload replaces
// them wholesale and they re-init against fresh sources on their own. Only an
// open overlay outlives the reload; tell it when its diagram's source changed
// underneath it so the frame can surface staleness (never silently merge).
async function refreshWhiteboardSource() {
  if (overlayIndex === null) return;
  const index = overlayIndex;
  try {
    const sources = await fetchMermaidSources();
    const source = sources.find((item) => item.index === index);
    const nextHash = source ? String(source.hash || "") : "";
    const record = whiteboardRecord(index);
    if (nextHash !== record.sourceHash) {
      record.source = source ? String(source.source || "") : "";
      record.sourceHash = nextHash;
      postToWhiteboardOverlay({
        type: "lavish-whiteboard:sourceChanged",
        source: record.source,
        sourceHash: record.sourceHash,
      });
    }
  } catch {
    // Best effort - the staleness banner also re-arms on the next open.
  }
}

function validWhiteboardIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index <= 999 ? index : null;
}

function handleAuthenticatedWhiteboardMessage(index, message, mode) {
  if (message.type === "lavish-whiteboard:save") handleWhiteboardSave(index, message, mode);
  if (message.type === "lavish-whiteboard:queueFeedback") queueWhiteboardFeedback(index, message, mode);
  if (message.type === "lavish-whiteboard:maximize" && mode === "inline") openWhiteboardOverlay(index);
  if (message.type === "lavish-whiteboard:close" && mode === "overlay") closeWhiteboard();
  if (message.type === "lavish-whiteboard:teardownReady") finishWhiteboardTeardown(index, message, mode);
  if (message.type === "lavish-whiteboard:teardownFailed") failWhiteboardTeardown(index, message, mode);
  if (message.type === "lavish-whiteboard:flushComplete") finishWhiteboardFlush(index, message, mode);
}

function handleInlineWhiteboardMessage(event, message) {
  if (ended) return;
  const index = validWhiteboardIndex(message.diagramIndex);
  if (index === null || !event.source) return;
  if (message.type === "lavish-whiteboard:ready") {
    if (inlineWhiteboardChannels.has(index)) return;
    const channelId = String(message.channelToken || "");
    if (!channelId) return;
    authenticateWhiteboardChannel(channelId).then((authenticated) => {
      if (!authenticated || ended || inlineWhiteboardChannels.has(index)) return;
      const channel = { window: event.source, channelId, initialized: false };
      inlineWhiteboardChannels.set(index, channel);
      whiteboardRecord(index).diagramId = String(message.diagramId || "");
      handleWhiteboardReady(index, "inline", () => inlineWhiteboardChannels.get(index) === channel).then(
        (initialized) => {
          if (inlineWhiteboardChannels.get(index) === channel) channel.initialized = initialized;
        },
      );
    });
    return;
  }
  const channel = inlineWhiteboardChannels.get(index);
  if (!channel || channel.window !== event.source || channel.channelId !== message.channelId) return;
  handleAuthenticatedWhiteboardMessage(index, message, "inline");
}

function handleOverlayWhiteboardMessage(event, message) {
  if (event.source !== whiteboardFrame.contentWindow || overlayIndex === null) return;
  const index = validWhiteboardIndex(message.diagramIndex);
  if (index === null || index !== overlayIndex) return;
  if (message.type === "lavish-whiteboard:ready") {
    if (overlayFrameReady || overlayChannelId) return;
    const channelId = String(message.channelToken || "");
    if (!channelId) return;
    overlayChannelId = channelId;
    authenticateWhiteboardChannel(channelId).then(async (authenticated) => {
      const isCurrent = () =>
        overlayIndex === index && overlayChannelId === channelId && event.source === whiteboardFrame.contentWindow;
      if (!authenticated) {
        if (isCurrent()) overlayChannelId = "";
        return;
      }
      if (!isCurrent()) return;
      const initialized = await handleWhiteboardReady(index, "overlay", isCurrent);
      if (initialized && isCurrent()) overlayFrameReady = true;
    });
    return;
  }
  if (!overlayFrameReady || message.channelId !== overlayChannelId) return;
  handleAuthenticatedWhiteboardMessage(index, message, "overlay");
}

window.addEventListener("message", (event) => {
  const message = event.data || {};
  if (event.source === whiteboardFrame.contentWindow) {
    handleOverlayWhiteboardMessage(event, message);
  } else {
    handleInlineWhiteboardMessage(event, message);
  }
});

function loadFrame() {
  if (artifactSrc) frame.src = artifactSrc;
}

function reloadArtifact() {
  closeMenus();
  resetFrame().then((reloaded) => {
    if (reloaded) refreshWhiteboardSource();
  });
}

async function reloadAfterServerRestart() {
  if (chromeRestartReloadPromise) return chromeRestartReloadPromise;
  chromeRestartReloadPromise = reloadChromeAfterServerRestart();
  return chromeRestartReloadPromise;
}

async function reloadChromeAfterServerRestart() {
  let sawOutage = false;
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (sawOutage && res.ok) {
        await flushWhiteboardsBeforeChromeReload();
        location.reload();
        return;
      }
    } catch {
      sawOutage = true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await flushWhiteboardsBeforeChromeReload();
  location.reload();
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;

  const msg = event.data || {};
  if (msg.type === "lavish:queuePrompt") {
    enqueuePrompt(msg.prompt);
  }
  if (msg.type === "lavish:snapshot") {
    const request = takeSnapshotRequest();
    // A snapshot that arrives after its request already timed out has no pending request left, and
    // acting on it would submit the queue a second time.
    const snapshotAction = request ? request.action : "";
    if (snapshotAction === "copy") {
      copyText(msg.snapshot || "");
    } else if (snapshotAction === "submit") {
      pendingSnapshot = msg.snapshot || "";
      submitQueued().catch(() => {});
    }
  }
  if (msg.type === "lavish:scroll") {
    lastScroll = { x: Number(msg.x) || 0, y: Number(msg.y) || 0 };
  }
  if (msg.type === "lavish:layoutWarnings") {
    handleLayoutWarningsForGate(msg.layout_warnings);
    submitLayoutWarnings(msg.layout_warnings).catch(() => {});
  }
  if (msg.type === "lavish:sendQueuedPrompts") sendQueued();
  if (msg.type === "lavish:endSession") endSession().catch(handleEndSessionFailure);
  if (msg.type === "lavish:toggleAnnotationMode") toggleAnnotationMode();
});

loadFrame();

function toggleAnnotationMode() {
  if (ended) return;
  annotation = !annotation;
  annotationSwitch.setAttribute("aria-pressed", String(annotation));
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation });
}

annotationSwitch.onclick = toggleAnnotationMode;

sendButton.onclick = () => sendQueued(false);
sendAndEndButton.onclick = () => sendQueued(true);
moreButton.onclick = () => toggleMenu(moreButton, moreMenu);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendQueued(false);
  }
});
chatInput.addEventListener("input", hideSendHint);
copyPathButton.onclick = copyFilePath;
reloadArtifactButton.onclick = reloadArtifact;
copySnapshotButton.onclick = copyDomSnapshot;
exportArtifactButton.onclick = exportArtifact;
shareArtifactButton.onclick = openShareDialog;
shareCloseButton.onclick = closeShareDialog;
shareCancelButton.onclick = closeShareDialog;
shareForm.addEventListener("submit", publishShare);
shareDialog.addEventListener("click", (event) => {
  if (event.target === shareDialog) closeShareDialog();
});
copyShareUrlButton.onclick = () => copyToButton(shareUrlInput.value, copyShareUrlButton, "Copy URL");
copyUpdateKeyButton.onclick = () => copyToButton(shareUpdateKeyInput.value, copyUpdateKeyButton, "Copy key");
endButton.onclick = () => {
  closeMenus();
  endSession().catch(handleEndSessionFailure);
};
submitRetryButton.onclick = () => {
  const retry = submitRetryAction;
  hideSubmitError();
  if (retry) retry();
};
document.addEventListener("mousedown", (event) => {
  const target = /** @type {Node} */ (event.target);
  if (!moreMenu.hidden && !moreWrap.contains(target)) setMenuOpen(moreButton, moreMenu, false);
});
whiteboardCloseButton.onclick = closeWhiteboard;
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!whiteboardOverlay.hidden) {
      closeWhiteboard();
    } else if (!shareDialog.hidden) {
      closeShareDialog();
    } else {
      closeMenus();
    }
  }
});
// Capture phase so the mode hotkey fires no matter where focus is in the chrome - including
// mid-keystroke in chatInput or an annotation-card textarea - without disturbing normal typing.
document.addEventListener(
  "keydown",
  (event) => {
    if (!isModeToggleHotkeyEvent(event)) return;
    event.preventDefault();
    toggleAnnotationMode();
  },
  true,
);
frame.addEventListener("load", () => {
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation && !ended });
  // Replay the pre-reload scroll position so hot reloads don't jump the artifact to the top.
  postToFrame({ type: "lavish:restoreScroll", x: lastScroll.x, y: lastScroll.y });
  if (overlayIndex !== null) {
    inlineWhiteboardChannels.delete(overlayIndex);
    postToFrame({ type: "lavish:suspendWhiteboard", diagramIndex: overlayIndex });
  }
});

initializeLayoutGate();

// The browser's own EventSource retry cannot be relied on here. Through `tailscale serve` a dead
// backend answers 502, and the WHATWG processing model fails a stream on any non-200 permanently -
// no reconnect, ever. The only recovery path Lavish had (the chrome-reload event) rode that same
// dead stream, so an outage left the page silently deaf until someone reloaded it by hand.
function connectEventStream() {
  clearTimeout(eventStreamReconnectTimer);
  eventStreamReconnectTimer = undefined;
  if (ended) return;

  closeEventStream();
  const stream = new EventSource("/events/" + key);
  eventStream = stream;

  stream.addEventListener("open", () => {
    if (stream !== eventStream) return;
    const reconnected = eventStreamEverOpened;
    eventStreamConnected = true;
    eventStreamEverOpened = true;
    eventStreamAttempt = 0;
    setConnectionBanner(false);
    noteEventStreamActivity();
    // Nothing replays what was missed while the stream was down, so a reconnected client re-reads
    // authoritative state instead of assuming the gap was empty.
    if (reconnected) resyncState().catch(() => {});
  });
  stream.addEventListener("error", () => {
    if (stream !== eventStream) return;
    handleEventStreamFailure();
  });
  stream.addEventListener("heartbeat", () => noteEventStreamActivity());
  stream.addEventListener("reload", () => {
    noteEventStreamActivity();
    resetFrame().then((reloaded) => {
      if (reloaded) refreshWhiteboardSource();
    });
  });
  stream.addEventListener("chrome-reload", () => reloadAfterServerRestart());
  stream.addEventListener("agent-reply", (event) => {
    noteEventStreamActivity();
    addChat("agent", JSON.parse(event.data).text);
  });
  stream.addEventListener("chat-sync", (event) => {
    noteEventStreamActivity();
    syncChat(JSON.parse(event.data).chat || []);
  });
  stream.addEventListener("agent-presence", (event) => {
    noteEventStreamActivity();
    setAgentPresence(JSON.parse(event.data).state);
  });
  stream.addEventListener("session-ended", () => markSessionEnded());
}

function closeEventStream() {
  if (!eventStream) return;
  eventStream.close?.();
  eventStream = null;
}

function stopEventStream() {
  clearTimeout(eventStreamReconnectTimer);
  eventStreamReconnectTimer = undefined;
  clearTimeout(eventStreamWatchdogTimer);
  eventStreamWatchdogTimer = undefined;
  eventStreamConnected = false;
  closeEventStream();
}

function handleEventStreamFailure() {
  clearTimeout(eventStreamWatchdogTimer);
  eventStreamWatchdogTimer = undefined;
  eventStreamConnected = false;
  closeEventStream();
  if (ended) return;
  setConnectionBanner(true);
  scheduleEventStreamReconnect();
}

function scheduleEventStreamReconnect() {
  clearTimeout(eventStreamReconnectTimer);
  const capped = Math.min(SSE_RECONNECT_MAX_MS, SSE_RECONNECT_BASE_MS * 2 ** eventStreamAttempt);
  eventStreamAttempt += 1;
  // Jitter across the capped window so every tab that lost the same server does not come back in
  // lockstep the moment it returns.
  const delay = Math.round(capped * (0.5 + Math.random() * 0.5));
  eventStreamReconnectTimer = setTimeout(connectEventStream, delay);
}

// A connection that goes half-open - a proxy dropping the path, a laptop suspending - keeps
// delivering nothing without ever firing `error`. Server heartbeats turn that silence into a
// detectable failure.
function noteEventStreamActivity() {
  clearTimeout(eventStreamWatchdogTimer);
  eventStreamWatchdogTimer = setTimeout(handleEventStreamFailure, SSE_HEARTBEAT_TIMEOUT_MS);
}

function reconnectEventStreamNow() {
  if (ended || eventStreamConnected) return;
  eventStreamAttempt = 0;
  connectEventStream();
}

async function resyncState() {
  if (resyncPromise) return resyncPromise;
  resyncPromise = resyncStateOnce();
  try {
    return await resyncPromise;
  } finally {
    resyncPromise = null;
  }
}

async function resyncStateOnce() {
  const response = await fetch("/api/" + key + "/state", { cache: "no-store" });
  if (!response.ok) throw new Error("failed to resync session state");
  const state = await response.json();
  syncChat(Array.isArray(state.chat) ? state.chat : []);
  setAgentPresence(String(state.presence || "waiting"));
  if (state.ended) markSessionEnded();
}

window.addEventListener("online", reconnectEventStreamNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") reconnectEventStreamNow();
});

connectEventStream();

render();
initialChat.forEach((item) => addChat(item.role, item.text));
setAgentPresence("waiting");
