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

test("recorder skips reports the store already classified as unchanged", async () => {
  await withTempDir(async (dir) => {
    const recorder = createLayoutWarningRecorder(dir);

    assert.equal(await recorder.record({ key: KEY, file: FILE, warnings: [warning()], changed: false }), 0);
    await assert.rejects(() => stat(layoutLogFile(dir)), /ENOENT/);
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
