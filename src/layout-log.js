import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

import { layoutWarningKey } from "./session-store.js";

// Durable, append-only history of every layout/overflow finding the browser reports.
//
// `SessionStore` deliberately drops these on delivery - `takeFeedback` clears
// `session.layout_warnings`, and `upsertSession` resets it on every reopen - so once the agent
// has read a warning there is no record that it ever happened. That makes recurring overflow
// mistakes invisible: the same selector can break in the same way across dozens of sessions and
// nothing on disk says so. This log is that record.
//
// It lives as a JSONL sidecar next to `state.json` rather than inside it, for the same reason
// whiteboard scenes were moved out (see `whiteboard-store.js`): `SessionStore` rewrites the whole
// state file on every mutation, and an append-only log grows without bound. Appends use
// `appendFile` - the temp-file-then-rename trick in `whiteboard-store.js` replaces a whole file
// and would truncate history here.

export const LAYOUT_LOG_FILENAME = "layout-warnings.jsonl";

// Size guard: past this threshold the log rotates to a single `.1` generation, so the worst-case
// on-disk footprint is ~2x this. Deliberately simple - one generation, no compression, no dated
// archives. Older-than-previous history is dropped rather than kept forever.
export const LAYOUT_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The canonical warning shape produced by `normalizeLayoutWarnings` in `session-store.js`.
 *
 * @typedef {object} LayoutWarning
 * @property {string} selector
 * @property {string} kind
 * @property {number} overflowPx
 * @property {number} viewportWidth
 * @property {string} severity
 * @property {boolean} persistent
 */

/**
 * One logged line: a single warning stamped with when and where it was seen.
 *
 * @typedef {LayoutWarning & { at: string, key: string, file: string }} LayoutWarningRecord
 */

/**
 * @param {string} stateRoot Directory holding `state.json`.
 * @returns {string} Path of the append-only log.
 */
export function layoutLogFile(stateRoot) {
  return path.join(stateRoot, LAYOUT_LOG_FILENAME);
}

/**
 * Append one JSON object per line, one line per warning.
 *
 * Flat per-warning records (rather than one record per report, with a nested array) keep the log
 * greppable: counting how often a selector overflows is a single pass with no nested walk, and a
 * truncated tail costs at most one warning instead of a whole report.
 *
 * Non-object entries are dropped and fields are coerced, so a malformed payload yields a
 * well-formed line or no line - never a broken one.
 *
 * @param {string} stateRoot Directory holding `state.json`.
 * @param {{ key: string, file: string, warnings: LayoutWarning[], at?: string }} report
 * @returns {Promise<number>} How many lines were appended.
 */
export async function appendLayoutWarnings(stateRoot, { key, file, warnings, at = new Date().toISOString() }) {
  const records = toWarningList(warnings).map((warning) => ({
    at,
    key: String(key || ""),
    file: String(file || ""),
    selector: String(warning.selector || ""),
    kind: String(warning.kind || "layout-warning"),
    overflowPx: finiteNumber(warning.overflowPx),
    viewportWidth: finiteNumber(warning.viewportWidth),
    severity: warning.severity === "warning" ? "warning" : "error",
    persistent: Boolean(warning.persistent),
  }));
  if (records.length === 0) return 0;
  const logFile = layoutLogFile(stateRoot);
  await mkdir(stateRoot, { recursive: true });
  await rotateIfOversized(logFile);
  // One append for the whole batch: a single write keeps a report's lines contiguous.
  await appendFile(logFile, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return records.length;
}

/**
 * Noise control, and the reason this is a stateful recorder rather than a bare function.
 *
 * The browser re-runs `auditLayout()` on every resize and the iframe only suppresses
 * exact-signature repeats, so dragging a window emits a stream of reports that differ solely in
 * `overflowPx`/`viewportWidth`. Logging each one would bury the signal in drag noise.
 *
 * Policy, per session:
 *  - A report the store already classified as unchanged is skipped outright.
 *  - A warning is logged the first time its `kind:selector` key appears, then suppressed for as
 *    long as it keeps being reported. The key is forgotten the moment a report omits it, so a
 *    warning that is fixed and later regresses gets logged again - that recurrence is precisely
 *    what the log exists to capture.
 *  - A key re-reported as `persistent` (it survived delivery to the agent) is logged again:
 *    "the fix did not take" is a distinct signal from the original sighting.
 *
 * Consequence worth knowing: the logged `overflowPx`/`viewportWidth` are those of the first
 * sighting in an episode, not the worst or the last. That is the deliberate trade for not
 * recording every frame of a window drag.
 *
 * The seen-set is per recorder rather than module-global, so each `serve()` owns its own and
 * tests stay isolated from each other.
 *
 * @param {string} stateRoot Directory holding `state.json`.
 * @param {{ onError?: ((error: Error) => void) | null }} [options]
 */
export function createLayoutWarningRecorder(stateRoot, { onError = null } = {}) {
  /** @type {Map<string, Set<string>>} */
  const loggedBySession = new Map();

  return {
    /**
     * Record a browser report. Never rejects and never throws: logging must not be able to fail
     * the endpoint that feeds it.
     *
     * @param {{ key: string, file: string, warnings: LayoutWarning[], changed?: boolean }} report
     * @returns {Promise<number>} How many lines were appended.
     */
    async record({ key, file, warnings, changed = true }) {
      const sessionKey = String(key || "");
      try {
        const list = toWarningList(warnings);
        const active = new Set(list.map(warningSignature));
        const alreadyLogged = loggedBySession.get(sessionKey) || new Set();
        // Everything still active is now either freshly logged below or was logged earlier, so
        // the active set is the next suppression set. Keys absent from this report drop out.
        loggedBySession.set(sessionKey, active);
        if (!changed) return 0;
        const fresh = list.filter((warning) => !alreadyLogged.has(warningSignature(warning)));
        if (fresh.length === 0) return 0;
        return await appendLayoutWarnings(stateRoot, { key: sessionKey, file, warnings: fresh });
      } catch (error) {
        // Forget this session's suppression set so the next report retries rather than treating
        // warnings that never reached disk as already logged.
        loggedBySession.delete(sessionKey);
        onError?.(/** @type {Error} */ (error));
        return 0;
      }
    },
  };
}

/**
 * Rotate to a single `.1` generation once the log passes the size guard.
 *
 * @param {string} logFile
 * @returns {Promise<void>}
 */
async function rotateIfOversized(logFile) {
  try {
    const { size } = await stat(logFile);
    if (size < LAYOUT_LOG_MAX_BYTES) return;
    await rename(logFile, `${logFile}.1`);
  } catch (error) {
    // No log yet is the normal first-write case, not a failure.
    if (error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return;
    throw error;
  }
}

/**
 * Suppression identity: the natural grouping key, plus the persistent flag so a warning that
 * survives delivery is logged a second time.
 *
 * @param {LayoutWarning} warning
 * @returns {string}
 */
function warningSignature(warning) {
  return `${layoutWarningKey(warning)}|${warning.persistent ? 1 : 0}`;
}

/**
 * @param {unknown} warnings
 * @returns {LayoutWarning[]}
 */
function toWarningList(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning) => warning && typeof warning === "object" && !Array.isArray(warning));
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
