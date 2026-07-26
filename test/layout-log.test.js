import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendLayoutWarnings,
  createLayoutWarningRecorder,
  LAYOUT_LOG_MAX_BYTES,
  layoutLogFile,
} from "../src/layout-log.js";

const KEY = "0123456789abcdef";
const FILE = "/tmp/artifact.html";

function warning(overrides = {}) {
  return {
    selector: "main > .card",
    kind: "element-horizontal-overflow",
    overflowPx: 24,
    viewportWidth: 720,
    severity: "error",
    persistent: false,
    ...overrides,
  };
}

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-layout-log-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readLines(dir) {
  const raw = await readFile(layoutLogFile(dir), "utf8");
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

test("appendLayoutWarnings writes one JSON object per line carrying the full finding", async () => {
  await withTempDir(async (dir) => {
    const appended = await appendLayoutWarnings(dir, {
      key: KEY,
      file: FILE,
      warnings: [warning(), warning({ selector: "html", kind: "page-horizontal-overflow", severity: "warning" })],
      at: "2026-07-18T12:00:00.000Z",
    });

    assert.equal(appended, 2);
    const lines = await readLines(dir);
    assert.deepEqual(lines[0], {
      at: "2026-07-18T12:00:00.000Z",
      key: KEY,
      file: FILE,
      selector: "main > .card",
      kind: "element-horizontal-overflow",
      overflowPx: 24,
      viewportWidth: 720,
      severity: "error",
      persistent: false,
    });
    assert.equal(lines[1].selector, "html");
    assert.equal(lines[1].kind, "page-horizontal-overflow");
    assert.equal(lines[1].severity, "warning");
  });
});

test("appendLayoutWarnings appends rather than replacing prior history", async () => {
  await withTempDir(async (dir) => {
    await appendLayoutWarnings(dir, { key: KEY, file: FILE, warnings: [warning({ selector: "#one" })] });
    await appendLayoutWarnings(dir, { key: KEY, file: FILE, warnings: [warning({ selector: "#two" })] });

    const lines = await readLines(dir);
    assert.deepEqual(
      lines.map((line) => line.selector),
      ["#one", "#two"],
    );
  });
});

test("appendLayoutWarnings stamps an ISO timestamp when the caller does not supply one", async () => {
  await withTempDir(async (dir) => {
    await appendLayoutWarnings(dir, { key: KEY, file: FILE, warnings: [warning()] });

    const [line] = await readLines(dir);
    assert.match(line.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

test("appendLayoutWarnings coerces malformed payloads instead of writing broken lines", async () => {
  await withTempDir(async (dir) => {
    const appended = await appendLayoutWarnings(dir, {
      key: KEY,
      file: FILE,
      // Nulls, primitives and arrays are dropped; the survivor has every field missing or junk.
      warnings: /** @type {any} */ ([null, "nope", 7, [], { overflowPx: "wide", viewportWidth: NaN, severity: "??" }]),
    });

    assert.equal(appended, 1);
    const [line] = await readLines(dir);
    assert.equal(line.selector, "");
    assert.equal(line.kind, "layout-warning");
    assert.equal(line.overflowPx, 0);
    assert.equal(line.viewportWidth, 0);
    assert.equal(line.severity, "error");
    assert.equal(line.persistent, false);
  });
});

test("appendLayoutWarnings writes nothing when there is nothing loggable", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await appendLayoutWarnings(dir, { key: KEY, file: FILE, warnings: [] }), 0);
    assert.equal(await appendLayoutWarnings(dir, { key: KEY, file: FILE, warnings: /** @type {any} */ (null) }), 0);
    await assert.rejects(() => stat(layoutLogFile(dir)), /ENOENT/);
  });
});

test("recorder logs a finding once and suppresses the resize storm that follows", async () => {
  await withTempDir(async (dir) => {
    const recorder = createLayoutWarningRecorder(dir);

    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [warning()] }), 1);
    // A window drag re-audits continuously: same element, same failure, different measurements.
    for (const viewportWidth of [719, 700, 688, 640]) {
      const dragged = warning({ viewportWidth, overflowPx: 1024 - viewportWidth });
      assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [dragged] }), 0);
    }

    const lines = await readLines(dir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].viewportWidth, 720);
  });
});

// The display `selector` is capped for readability, so two different elements deep in the DOM
// can render as the same string. Suppressing on it dropped one of them from the log forever.
test("two elements sharing a truncated selector are logged as two records", async () => {
  await withTempDir(async (dir) => {
    const recorder = createLayoutWarningRecorder(dir);
    const shared = { selector: "div > div > div > div > pre", kind: "element-scroll-overflow" };
    const firstIdentity = "html > body > div:nth-of-type(1) > div > div > div > div > pre";
    const secondIdentity = "html > body > div:nth-of-type(2) > div > div > div > div > pre";
    const first = warning({ ...shared, identity: firstIdentity });
    const second = warning({ ...shared, identity: secondIdentity });

    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [first] }), 1);
    // A second, different element later breaks the same way. It renders as the same capped
    // selector, so suppression keyed on that selector would treat it as already-logged and
    // drop it permanently - the page keeps reporting it, so no later report presents it as new.
    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [first, second] }), 1);
    // Both on disk now: identity dedupes, it does not merely disable dedupe.
    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [first, second] }), 0);

    const lines = await readLines(dir);
    assert.deepEqual(
      lines.map((line) => line.identity),
      [firstIdentity, secondIdentity],
    );
    assert.deepEqual(
      lines.map((line) => line.selector),
      [shared.selector, shared.selector],
      "the human-readable selector is unchanged, and is deliberately ambiguous here",
    );
  });
});

test("a record omits identity when the display selector is already the whole path", async () => {
  await withTempDir(async (dir) => {
    await appendLayoutWarnings(dir, { key: KEY, file: FILE, warnings: [warning()], at: "2026-07-18T12:00:00.000Z" });

    const [line] = await readLines(dir);
    assert.equal(
      Object.hasOwn(line, "identity"),
      false,
      "records that were never ambiguous keep the exact shape - and the exact key - they had before",
    );
  });
});

test("a warning whose write failed is still logged by the next report of the same warning", async () => {
  await withTempDir(async (dir) => {
    // Reproduces the server interleaving that a retry-with-changed:true test cannot reach.
    // `SessionStore` persists the warning to state.json *before* the recorder runs, so once an
    // append fails, every later report of that still-broken element is one the store calls
    // unchanged. Suppressing on sight would strand the finding permanently.
    const root = path.join(dir, "root");
    // A regular file where the state root should be: every write beneath it fails.
    await writeFile(root, "not a directory");
    const errors = [];
    const recorder = createLayoutWarningRecorder(root, { onError: (error) => errors.push(error) });

    // The store has already persisted this warning; the log write throws.
    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [warning()] }), 0);
    assert.equal(errors.length, 1);

    await rm(root);

    // The browser re-reports the identical warning - `changed: false` territory. The element is
    // still broken on the page, so nothing later will ever present it as new: log it now or lose it.
    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [warning()] }), 1);
    // ...and now that it is genuinely on disk, the resize storm is suppressed as usual.
    const dragged = warning({ overflowPx: 60, viewportWidth: 600 });
    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [dragged] }), 0);

    const lines = await readLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].overflowPx, 24);
  });
});

test("concurrent writes against an oversized log rotate exactly once and lose nothing", async () => {
  await withTempDir(async (dir) => {
    const logFile = layoutLogFile(dir);
    await writeFile(logFile, Buffer.alloc(LAYOUT_LOG_MAX_BYTES, "x"));
    const selectors = ["#a", "#b", "#c", "#d", "#e"];

    // Guards the serialization contract rather than reproducing a specific interleaving. The
    // race this protects against - one call stats an oversized log, a second rotates and appends
    // in the gap, then the first renames that fresh small log over the `.1` archive - needs a
    // skew between two stat/rename pairs that a black-box test cannot force. Serializing the
    // whole stat/rotate/append section closes the window by construction; this pins the outcome
    // so a future change that reopens it has to fail something.
    await Promise.all(
      selectors.map((selector) =>
        appendLayoutWarnings(dir, { key: KEY, file: FILE, warnings: [warning({ selector })] }),
      ),
    );

    // The retained generation is still the original archive, not somebody's fresh small log.
    const rotated = await stat(`${logFile}.1`);
    assert.equal(rotated.size, LAYOUT_LOG_MAX_BYTES);
    // One rotation, and every concurrent record landed in the log that survived it.
    const lines = await readLines(dir);
    assert.deepEqual(lines.map((line) => line.selector).sort(), [...selectors].sort());
  });
});

test("concurrent reports of the same warning log it once, not once per racing report", async () => {
  await withTempDir(async (dir) => {
    const recorder = createLayoutWarningRecorder(dir);

    // The suppression set is now updated only after a successful write, so the decide-then-write
    // section has to be serialized for this to hold: otherwise both calls would read an empty set,
    // both classify the warning as fresh, and both append it.
    const counts = await Promise.all([
      recorder.record({ key: KEY, file: FILE, warnings: [warning()] }),
      recorder.record({ key: KEY, file: FILE, warnings: [warning()] }),
    ]);

    assert.deepEqual(counts.sort(), [0, 1]);
    assert.equal((await readLines(dir)).length, 1);
  });
});

test("recorders sharing a state dir serialize against each other", async () => {
  await withTempDir(async (dir) => {
    const logFile = layoutLogFile(dir);
    await writeFile(logFile, Buffer.alloc(LAYOUT_LOG_MAX_BYTES, "x"));
    const first = createLayoutWarningRecorder(dir);
    const second = createLayoutWarningRecorder(dir);

    await Promise.all([
      first.record({ key: KEY, file: FILE, warnings: [warning({ selector: "#first" })] }),
      second.record({ key: KEY, file: FILE, warnings: [warning({ selector: "#second" })] }),
    ]);

    assert.equal((await stat(`${logFile}.1`)).size, LAYOUT_LOG_MAX_BYTES);
    assert.deepEqual((await readLines(dir)).map((line) => line.selector).sort(), ["#first", "#second"]);
  });
});

test("recorder logs a regression: a warning that cleared and came back is a new episode", async () => {
  await withTempDir(async (dir) => {
    const recorder = createLayoutWarningRecorder(dir);

    await recorder.record({ key: KEY, file: FILE, warnings: [warning()] });
    // The agent fixed it - the next audit reports a clean page, retiring the key.
    await recorder.record({ key: KEY, file: FILE, warnings: [] });
    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [warning()] }), 1);

    const lines = await readLines(dir);
    assert.equal(lines.length, 2);
  });
});

test("recorder logs a finding again once it is re-reported as persistent", async () => {
  await withTempDir(async (dir) => {
    const recorder = createLayoutWarningRecorder(dir);

    await recorder.record({ key: KEY, file: FILE, warnings: [warning()] });
    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [warning({ persistent: true })] }), 1);
    // ...but only once: the persistent re-report is itself deduped from then on.
    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [warning({ persistent: true })] }), 0);

    const lines = await readLines(dir);
    assert.deepEqual(
      lines.map((line) => line.persistent),
      [false, true],
    );
  });
});

test("recorder tracks suppression per session, not globally", async () => {
  await withTempDir(async (dir) => {
    const recorder = createLayoutWarningRecorder(dir);
    const otherKey = "fedcba9876543210";

    await recorder.record({ key: KEY, file: FILE, warnings: [warning()] });
    assert.equal(await recorder.record({ key: otherKey, file: "/tmp/other.html", warnings: [warning()] }), 1);

    const lines = await readLines(dir);
    assert.deepEqual(
      lines.map((line) => line.key),
      [KEY, otherKey],
    );
  });
});

test("recorder never throws on a write failure, reports it, and retries next time", async () => {
  await withTempDir(async (dir) => {
    // A regular file where the state root should be: every write beneath it fails.
    const blocked = path.join(dir, "blocked");
    await writeFile(blocked, "not a directory");
    const errors = [];
    const recorder = createLayoutWarningRecorder(blocked, { onError: (error) => errors.push(error) });

    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [warning()] }), 0);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);

    // The failed warning was not marked as logged, so an identical report tries again.
    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [warning()] }), 0);
    assert.equal(errors.length, 2);
  });
});

test("a throwing onError hook cannot turn a caught write failure into a failed report", async () => {
  await withTempDir(async (dir) => {
    // `onError` is arbitrary caller code - in the server it is `serve({ log })`. If it throws,
    // an unguarded call would reject `record`, the handler's outer try would forward to Express,
    // and reporting the failure would itself fail the POST.
    const blocked = path.join(dir, "blocked");
    await writeFile(blocked, "not a directory");
    const recorder = createLayoutWarningRecorder(blocked, {
      onError: () => {
        throw new Error("logger exploded");
      },
    });

    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [warning()] }), 0);
  });
});

test("an onError hook that rejects does not escape as an unhandled rejection", async () => {
  await withTempDir(async (dir) => {
    const blocked = path.join(dir, "blocked");
    await writeFile(blocked, "not a directory");
    const unhandled = [];
    const trackUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", trackUnhandled);
    try {
      const recorder = createLayoutWarningRecorder(blocked, {
        onError: () => Promise.reject(new Error("async logger exploded")),
      });

      assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [warning()] }), 0);
      // Let the microtask checkpoint pass, which is when an unhandled rejection would be raised.
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", trackUnhandled);
    }
  });
});

test("recorder swallows write failures even without an onError hook", async () => {
  await withTempDir(async (dir) => {
    const blocked = path.join(dir, "blocked");
    await writeFile(blocked, "not a directory");
    const recorder = createLayoutWarningRecorder(blocked);

    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [warning()] }), 0);
  });
});

test("the log rotates to a single .1 generation once it passes the size guard", async () => {
  await withTempDir(async (dir) => {
    const logFile = layoutLogFile(dir);
    await writeFile(logFile, Buffer.alloc(LAYOUT_LOG_MAX_BYTES, "x"));

    await appendLayoutWarnings(dir, { key: KEY, file: FILE, warnings: [warning({ selector: "#after-rotate" })] });

    const rotated = await stat(`${logFile}.1`);
    assert.equal(rotated.size, LAYOUT_LOG_MAX_BYTES);
    const lines = await readLines(dir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].selector, "#after-rotate");
  });
});
