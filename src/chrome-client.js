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
const panelHead = /** @type {HTMLDivElement} */ (document.getElementById("panelHead"));
const sheetToggle = /** @type {HTMLButtonElement} */ (document.getElementById("sheetToggle"));
const sheetCount = /** @type {HTMLSpanElement} */ (document.getElementById("sheetCount"));
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
let snapshotRequestSeq = 0;
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
// A stream that opens with HTTP 200 and is dropped immediately would otherwise reset the backoff
// on every `open`, pinning every retry to the first-attempt window. The backoff only resets once
// the connection has proven itself: a heartbeat received, or this long without failing.
const SSE_HEALTHY_AFTER_MS = 20_000;

/** @type {EventSource | null} */
let eventStream = null;
let eventStreamConnected = false;
// Bumped for every connection attempt. Anything that arrives tagged with an older generation -
// a stream we have already replaced, or a /state response from a server that has since restarted -
// is stale by construction and must not touch state.
let eventStreamGeneration = 0;
let eventStreamAttempt = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let eventStreamReconnectTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let eventStreamWatchdogTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let eventStreamHealthyTimer;
/** @type {Promise<void> | null} */
let resyncPromise = null;
// Highest server revision whose state has been applied, and the server instance it belongs to.
// Revisions live in the server's memory and restart at zero, so they only mean anything paired
// with the boot id that issued them.
let appliedStateRevision = -1;
let appliedStateBootId = "";
let presenceStalled = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let presenceStallTimer;
let pendingComposerPrompt = null;
let pendingComposerText = "";
let pendingUserBubble = null;
let lastSendEndAfter = false;
/** @type {(() => void) | null} */
let submitRetryAction = null;

// ---------------------------------------------------------------------------
// Mobile conversation sheet.
//
// Below the chrome's narrow breakpoint the Conversation panel is a bottom sheet instead of a
// permanently open row: chrome.css sizes it from `data-lavish-sheet` on <body>, this owns the
// state. It starts collapsed so the artifact gets the screen, and opens itself whenever there is
// something in it worth reading - the reviewer should never have to discover that the agent replied.
// Every entry point is a no-op on desktop, where the panel is a plain always-visible column.
// ---------------------------------------------------------------------------
const SHEET_BREAKPOINT_QUERY = "(max-width: 860px)";
const SHEET_STATES = ["collapsed", "half", "expanded"];
// Below this a header drag is a tap, not a swipe - fingers are never perfectly still.
const SHEET_SWIPE_THRESHOLD_PX = 24;
const mobileSheetQuery = typeof window.matchMedia === "function" ? window.matchMedia(SHEET_BREAKPOINT_QUERY) : null;
let sheetState = "collapsed";
let sheetDragStartY = null;

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
  updateSheetCount();
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
  // Send & End is deliberately not unlocked by the stall. Ordinary Send is safe either way - the
  // feedback stays queued and the server drops presence to waiting once nothing is polling - but
  // ending would tear down a session underneath an agent that really is still working. It comes
  // back as soon as the server itself says the agent is gone.
  sendAndEndButton.disabled = ended || agentPresence === "working";
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

// Applies a whole server state - chat, presence and ended together - if it is newer than what is
// already on screen. They move as one because applying them separately is what let the initial
// presence be dropped behind the chat that shared its revision.
function applyServerState(payload, generation) {
  if (!payload || typeof payload !== "object") return false;
  // Never trust a connection we have already given up on. This is what keeps a stale instance from
  // ending the session, or rolling presence back, after a newer one has been accepted.
  if (generation !== eventStreamGeneration) return false;

  const bootId = typeof payload.bootId === "string" ? payload.bootId : "";
  if (bootId && bootId !== appliedStateBootId) {
    // Boot ids are compared for identity, never for order - a different server is simply a
    // different server, and its revision counter starts fresh, so the watermark re-bases. Ordering
    // them would mean a replacement could be judged "older" and ignored forever.
    appliedStateBootId = bootId;
    appliedStateRevision = -1;
  }

  const revision = Number(payload.revision);
  if (Number.isFinite(revision)) {
    if (revision <= appliedStateRevision) return false;
    appliedStateRevision = revision;
  }

  // Chat is optional: a degraded push from a server whose store is unreadable still carries
  // trustworthy in-memory presence, and must leave the conversation alone rather than blank it.
  const agentMessagesBefore = renderedAgentMessageCount();
  if (Array.isArray(payload.chat)) syncChat(payload.chat);

  // What "an agent reply landed" means now that there is no agent-reply delta: the state we have
  // just ACCEPTED shows the reviewer an agent message they did not have before. Everything above
  // this line is the gate - a payload from a connection generation we have replaced, or one that
  // loses the revision comparison, has already returned false - so a stale or superseded payload
  // can never raise the sheet. Keep this call below the gate: raising first and validating after
  // would let a dead server's leftover push pop the sheet open over a live session.
  //
  // Measured against the rendered log rather than against the payload, so every route into the
  // conversation counts as "already seen": the chat rendered at page load, an earlier accepted
  // state, and the /state re-check all leave their messages on screen. A whole-state push that
  // merely repeats what is already there therefore does not re-open a sheet the reviewer collapsed,
  // which is what makes idempotent re-application safe for the sheet as well as for the bubbles.
  if (renderedAgentMessageCount() > agentMessagesBefore) openSheetAtLeast("half");

  setAgentPresence(String(payload.presence || "waiting"));
  // Applied last, and after the sheet: a final reply that shares its state with the ending is still
  // a reply worth showing, and openSheetAtLeast is deliberately inert once `ended` is set.
  if (payload.ended) markSessionEnded();
  return true;
}

function hideSendHint() {
  clearTimeout(sendHintTimer);
  sendHint.hidden = true;
}

function isMobileSheet() {
  return Boolean(mobileSheetQuery && mobileSheetQuery.matches);
}

function setSheetState(next) {
  sheetState = SHEET_STATES.includes(next) ? next : "collapsed";
  document.body.dataset.lavishSheet = sheetState;
  const expanded = sheetState !== "collapsed";
  sheetToggle.setAttribute("aria-expanded", String(expanded));
  sheetToggle.setAttribute("aria-label", expanded ? "Collapse conversation" : "Expand conversation");
}

// Auto-OPEN only, never auto-close. A collapse is a decision the reviewer made about their own
// screen and nothing here may undo it; a message they have not seen yet, on the other hand, must
// not sit silently behind a 52px handle.
function openSheetAtLeast(state) {
  if (!isMobileSheet() || ended) return;
  if (SHEET_STATES.indexOf(sheetState) >= SHEET_STATES.indexOf(state)) return;
  setSheetState(state);
}

function cycleSheetState() {
  setSheetState(SHEET_STATES[(SHEET_STATES.indexOf(sheetState) + 1) % SHEET_STATES.length]);
}

function stepSheetState(direction) {
  const index = SHEET_STATES.indexOf(sheetState) + direction;
  if (index < 0 || index >= SHEET_STATES.length) return;
  setSheetState(SHEET_STATES[index]);
}

// Queued annotations live inside the sheet, so a collapsed sheet has to carry the count or feedback
// piles up somewhere the reviewer cannot see it.
function updateSheetCount() {
  sheetCount.textContent = String(queued.length);
  sheetCount.hidden = queued.length === 0;
}

// A drag on the handle steps one state per swipe; anything shorter than the threshold was a tap,
// which cycles. The toggle button is excluded so its own click handler stays the single driver
// there - otherwise a tap on it would both step and cycle.
function handleSheetPointerDown(event) {
  // Cleared on every press, not only presses on the handle: a drag that ends inside the artifact
  // iframe never delivers its pointerup to the chrome, and a start point left over from it would
  // be read as a swipe by whatever release comes next.
  sheetDragStartY = null;
  if (!isMobileSheet() || event.button) return;
  const target = /** @type {Node} */ (event.target);
  if (!panelHead.contains(target) || sheetToggle.contains(target)) return;
  sheetDragStartY = Number(event.clientY) || 0;
}

function handleSheetPointerUp(event) {
  if (sheetDragStartY === null) return;
  const travel = sheetDragStartY - (Number(event.clientY) || 0);
  sheetDragStartY = null;
  if (!isMobileSheet()) return;
  if (Math.abs(travel) < SHEET_SWIPE_THRESHOLD_PX) cycleSheetState();
  else stepSheetState(travel > 0 ? 1 : -1);
}

// `position: fixed` is anchored to the LAYOUT viewport, which iOS does not shrink when the soft
// keyboard opens - so the sheet, and with it the composer the user is typing into, ends up beneath
// the keyboard. visualViewport is the only surface that reports the keyboard at all. Reading it
// only while the composer has focus keeps a pinch-zoom (which also shrinks the visual viewport)
// from shoving the sheet around.
function syncKeyboardInset() {
  const viewport = window.visualViewport;
  if (!viewport || typeof document.body.style?.setProperty !== "function") return;
  const inset =
    document.activeElement === chatInput
      ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))
      : 0;
  document.body.style.setProperty("--sheet-keyboard-inset", `${inset}px`);
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

// How many agent messages the reviewer can actually see. The transient "Working..." bubble is not
// one of them, and neither is an agent entry with no text, which addChat declines to render.
function renderedAgentMessageCount() {
  return chatLog.querySelectorAll(".bubble.agent:not(.agent-working)").length;
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
  // Kept short on purpose: the phone panel gives the chat only a few lines, and an explanation
  // that scrolls out of view explains nothing.
  workingBubble.innerHTML =
    '<span class="spinner"></span><span>No word from your agent for a while. You can send again - nothing is lost.</span>';
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
  // The reviewer just queued feedback from the artifact; Send to Agent lives in the sheet.
  openSheetAtLeast("half");
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
  snapshotRequestSeq += 1;
  const request = { id: "lavish-snapshot-" + snapshotRequestSeq, action, settled: false, timer: undefined };
  request.timer = setTimeout(() => handleSnapshotTimeout(request), SNAPSHOT_TIMEOUT_MS);
  snapshotRequests.push(request);
  postToFrame({ type: "lavish:requestSnapshot", requestId: request.id });
}

// Resolved strictly by id. Matching positionally would let a late answer to a request that already
// timed out satisfy the next one, submitting it with a stale DOM snapshot - or under the wrong
// action entirely, since a copy and a send look identical once the queue has shifted.
function takeSnapshotRequest(requestId) {
  const index = snapshotRequests.findIndex((request) => request.id === requestId);
  if (index === -1) return null;
  const [request] = snapshotRequests.splice(index, 1);
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
  if (ended) return;
  // Same asymmetry as updateSendState, for the paths that bypass the buttons.
  if (agentPresence === "working" && (endAfter || !presenceStalled)) return;
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
  try {
    const response = await fetch("/api/" + key + "/whiteboard-channel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return response.ok;
  } catch {
    return false;
  }
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
      if (ended || inlineWhiteboardChannels.has(index)) return;
      // The artifact SDK keeps the plain diagram visible until the editor is
      // confirmed working, so every boot outcome must be reported: active swaps
      // the whiteboard in, unavailable restores the diagram instead of leaving
      // a silently blank frame.
      if (!authenticated) {
        postToFrame({ type: "lavish:whiteboardUnavailable", diagramIndex: index });
        return;
      }
      const channel = { window: event.source, channelId, initialized: false };
      inlineWhiteboardChannels.set(index, channel);
      whiteboardRecord(index).diagramId = String(message.diagramId || "");
      handleWhiteboardReady(index, "inline", () => inlineWhiteboardChannels.get(index) === channel).then(
        (initialized) => {
          if (inlineWhiteboardChannels.get(index) !== channel) return;
          channel.initialized = initialized;
          if (initialized) {
            postToFrame({ type: "lavish:whiteboardActive", diagramIndex: index });
            return;
          }
          inlineWhiteboardChannels.delete(index);
          postToFrame({ type: "lavish:whiteboardUnavailable", diagramIndex: index });
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
        if (isCurrent()) {
          overlayChannelId = "";
          showWhiteboardError(
            "Could not open the whiteboard: the editor frame could not authenticate with the local server.",
          );
        }
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
    const request = takeSnapshotRequest(msg.requestId);
    // A snapshot whose request already timed out no longer matches any id, and acting on it would
    // submit the queue a second time - or hand the next request someone else's stale DOM.
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
chatInput.addEventListener("focus", () => {
  openSheetAtLeast("half");
  syncKeyboardInset();
});
chatInput.addEventListener("blur", syncKeyboardInset);
sheetToggle.onclick = cycleSheetState;
// Capture phase, on the document rather than the handle, so the start point is reset by every
// press before the handle gets a chance to record a new one.
document.addEventListener("pointerdown", handleSheetPointerDown, true);
document.addEventListener("pointerup", handleSheetPointerUp);
window.visualViewport?.addEventListener("resize", syncKeyboardInset);
window.visualViewport?.addEventListener("scroll", syncKeyboardInset);
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
    } else if (moreMenu.hidden && isMobileSheet() && sheetState !== "collapsed") {
      // Innermost thing first: an open menu still outranks the sheet it is sitting over.
      setSheetState("collapsed");
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
  eventStreamGeneration += 1;
  const generation = eventStreamGeneration;
  const stream = new EventSource("/events/" + key);
  eventStream = stream;

  stream.addEventListener("open", () => {
    if (generation !== eventStreamGeneration) return;
    eventStreamConnected = true;
    clearTimeout(eventStreamHealthyTimer);
    eventStreamHealthyTimer = setTimeout(markEventStreamHealthy, SSE_HEALTHY_AFTER_MS);
    setConnectionBanner(false);
    noteEventStreamActivity();
    // No separate resync is needed: the server opens every connection by pushing the whole state,
    // so reconnecting is itself the recovery.
  });
  stream.addEventListener("error", () => {
    if (generation !== eventStreamGeneration) return;
    handleEventStreamFailure();
  });
  stream.addEventListener("heartbeat", () => {
    // A heartbeat is proof the server is really talking to us, not just accepting sockets.
    markEventStreamHealthy();
    noteEventStreamActivity();
  });
  stream.addEventListener("reload", () => {
    noteEventStreamActivity();
    resetFrame().then((reloaded) => {
      if (reloaded) refreshWhiteboardSource();
    });
  });
  stream.addEventListener("chrome-reload", () => reloadAfterServerRestart());
  // The server sends whole states, never chat deltas, so re-applying an overlapping one is a
  // no-op rather than a duplicated bubble. It arrives unprompted on every connect, which is what
  // makes reconnecting a complete recovery without a separate fetch.
  stream.addEventListener("state", (event) => {
    if (generation !== eventStreamGeneration) return;
    noteEventStreamActivity();
    applyServerState(JSON.parse(event?.data || "{}"), generation);
  });
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
  clearTimeout(eventStreamHealthyTimer);
  eventStreamHealthyTimer = undefined;
  eventStreamConnected = false;
  closeEventStream();
}

function markEventStreamHealthy() {
  eventStreamHealthyTimer = undefined;
  eventStreamAttempt = 0;
}

function handleEventStreamFailure() {
  clearTimeout(eventStreamWatchdogTimer);
  eventStreamWatchdogTimer = undefined;
  clearTimeout(eventStreamHealthyTimer);
  eventStreamHealthyTimer = undefined;
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
  // Tagged with the connection it was asked on: if the stream has been replaced by the time this
  // lands, the answer describes a server we are no longer talking to. `ended` goes through the
  // same check - a stale terminal response must not be able to close the session.
  const generation = eventStreamGeneration;
  const response = await fetch("/api/" + key + "/state", { cache: "no-store" });
  if (!response.ok) throw new Error("failed to resync session state");
  applyServerState(await response.json(), generation);
}

window.addEventListener("online", reconnectEventStreamNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") reconnectEventStreamNow();
});

connectEventStream();

// Collapsed is the load-time default on narrow screens: the artifact is what the reviewer opened
// Lavish to look at, and the sheet opens itself the moment it has something to say.
setSheetState("collapsed");
render();
initialChat.forEach((item) => addChat(item.role, item.text));
setAgentPresence("waiting");
