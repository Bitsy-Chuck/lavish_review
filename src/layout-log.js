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

// Serializes every write to a given log file. `stat` -> optional rotate -> append is a
// read-modify-write on one shared file: two callers that both see an oversized log would each
// rename it to `.1`, and the second rename would clobber the first caller's archive with a log
// that had already been rotated out from under it. Same serialize-writes shape as
// `queueWhiteboardWrite` in `whiteboard-store.js`, keyed by the resource (the log path) rather
// than the caller, so recorders sharing a state dir share one chain.
/** @type {Map<string, Promise<unknown>>} */
const writeTails = new Map();

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
  const records = buildRecords({ key, file, warnings, at });
  if (records.length === 0) return 0;
  const logFile = layoutLogFile(stateRoot);
  return queueLogWrite(logFile, () => writeRecords(stateRoot, logFile, records));
}

/**
 * Noise control, and the reason this is a stateful recorder rather than a bare function.
 *
 * The browser re-runs `auditLayout()` on every resize and the iframe only suppresses
 * exact-signature repeats, so dragging a window emits a stream of reports that differ solely in
 * `overflowPx`/`viewportWidth`. Logging each one would bury the signal in drag noise.
 *
 * Policy, per session:
 *  - A warning is logged the first time its `kind:selector` key appears, then suppressed for as
 *    long as it keeps being reported. The key is forgotten the moment a report omits it, so a
 *    warning that is fixed and later regresses gets logged again - that recurrence is precisely
 *    what the log exists to capture.
 *  - A key re-reported as `persistent` (it survived delivery to the agent) is logged again:
 *    "the fix did not take" is a distinct signal from the original sighting.
 *
 * The suppression set holds only signatures this recorder has *successfully written to disk*,
 * never merely ones it has seen. That distinction is load-bearing: the store persists a warning
 * to state.json before this recorder runs, so if the append fails the browser's next report of
 * the same warning is one the store considers unchanged. Suppressing on sight would drop that
 * warning from the log permanently - it stays active on the page, so no later report ever
 * presents it as new. Because the set means "on disk", a failed write simply leaves the
 * signature absent and the very next report - changed or not - writes it. This is also why the
 * recorder ignores the store's `changed` flag entirely: an unchanged report whose warnings are
 * all already on disk is filtered by the set anyway, and one whose warnings are *not* on disk is
 * exactly the report that must still be logged.
 *
 * Consequences worth knowing:
 *  - The logged `overflowPx`/`viewportWidth` are those of the first sighting in an episode, not
 *    the worst or the last. That is the deliberate trade for not recording every frame of a drag.
 *  - Suppression is in-memory only. A server restart forgets it, so an episode that spans the
 *    restart is logged a second time and recurrence counts read slightly high. Accepted: the
 *    alternative is persisting suppression state, which is a second durable store to keep
 *    consistent with the log it guards.
 *  - A write that fails after partially flushing can duplicate a line on the retry. Duplicates
 *    are recoverable by a reader; a silently dropped finding is not.
 *
 * @param {string} stateRoot Directory holding `state.json`.
 * @param {{ onError?: ((error: Error) => void) | null }} [options]
 */
export function createLayoutWarningRecorder(stateRoot, { onError = null } = {}) {
  // sessionKey -> signatures known to be on disk and still being reported.
  /** @type {Map<string, Set<string>>} */
  const writtenBySession = new Map();

  return {
    /**
     * Record a browser report. Never rejects and never throws: logging must not be able to fail
     * the endpoint that feeds it.
     *
     * @param {{ key: string, file: string, warnings: LayoutWarning[] }} report
     * @returns {Promise<number>} How many lines were appended.
     */
    async record({ key, file, warnings }) {
      const sessionKey = String(key || "");
      const at = new Date().toISOString();
      const logFile = layoutLogFile(stateRoot);
      try {
        // The whole read-modify-write - decide what is new, write it, then mark it written -
        // runs inside the log's write queue, so concurrent reports cannot both classify the same
        // warning as fresh and double-log it.
        return await queueLogWrite(logFile, async () => {
          const list = toWarningList(warnings);
          const active = new Set(list.map(warningSignature));
          // Retain only already-written signatures that are still being reported; anything the
          // page stopped reporting is forgotten, so a regression starts a new episode.
          const written = retainActive(writtenBySession.get(sessionKey), active);
          const fresh = list.filter((warning) => !written.has(warningSignature(warning)));
          if (fresh.length === 0) {
            rememberWritten(writtenBySession, sessionKey, written);
            return 0;
          }
          const appended = await writeRecords(
            stateRoot,
            logFile,
            buildRecords({ key: sessionKey, file, warnings: fresh, at }),
          );
          // Only now are these signatures durable. Reached solely on a successful write - a
          // throw skips it, leaving them absent so the next report retries them.
          for (const warning of fresh) written.add(warningSignature(warning));
          rememberWritten(writtenBySession, sessionKey, written);
          return appended;
        });
      } catch (error) {
        // Deliberately leaves this session's set untouched: it still describes what genuinely
        // reached disk, and re-deriving it from the next report is both correct and automatic.
        onError?.(/** @type {Error} */ (error));
        return 0;
      }
    },
  };
}

/**
 * Serialize an operation against a log file behind every write already queued for it. Callers
 * inside the queue must use `writeRecords` directly - re-entering the queue would deadlock.
 *
 * @template T
 * @param {string} logFile
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
function queueLogWrite(logFile, operation) {
  const queueKey = path.resolve(logFile);
  const prior = writeTails.get(queueKey) || Promise.resolve();
  const result = prior.catch(() => {}).then(operation);
  const tail = result.catch(() => {});
  writeTails.set(queueKey, tail);
  tail.finally(() => {
    if (writeTails.get(queueKey) === tail) writeTails.delete(queueKey);
  });
  return result;
}

/**
 * The unqueued write core: rotate if the guard is tripped, then append. Only ever called from
 * inside `queueLogWrite`, which is what makes the stat/rotate/append sequence atomic against
 * other writers in this process.
 *
 * @param {string} stateRoot
 * @param {string} logFile
 * @param {LayoutWarningRecord[]} records
 * @returns {Promise<number>}
 */
async function writeRecords(stateRoot, logFile, records) {
  await mkdir(stateRoot, { recursive: true });
  await rotateIfOversized(logFile);
  // One append for the whole batch. Serialization by `queueLogWrite` is what keeps a report's
  // lines contiguous against other writers in this process; a separate process appending to the
  // same log can still interleave between them.
  await appendFile(logFile, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return records.length;
}

/**
 * @param {{ key: string, file: string, warnings: LayoutWarning[], at: string }} report
 * @returns {LayoutWarningRecord[]}
 */
function buildRecords({ key, file, warnings, at }) {
  return toWarningList(warnings).map((warning) => ({
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
 * Store a session's written set, dropping the entry entirely once it is empty so a long-running
 * server does not retain a `Set` per session it has ever seen.
 *
 * @param {Map<string, Set<string>>} writtenBySession
 * @param {string} sessionKey
 * @param {Set<string>} written
 * @returns {void}
 */
function rememberWritten(writtenBySession, sessionKey, written) {
  if (written.size === 0) writtenBySession.delete(sessionKey);
  else writtenBySession.set(sessionKey, written);
}

/**
 * @param {Set<string> | undefined} written
 * @param {Set<string>} active
 * @returns {Set<string>} The written signatures still present in the current report.
 */
function retainActive(written, active) {
  const retained = new Set();
  if (!written) return retained;
  for (const signature of written) if (active.has(signature)) retained.add(signature);
  return retained;
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
