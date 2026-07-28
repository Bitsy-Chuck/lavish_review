import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/session-store.js";

function feedbackResult(result) {
  assert.equal(result.status, "feedback");
  return /** @type {{ status: string, dom_snapshot: string, prompts: any[], layout_warnings?: any[], session_ended?: boolean, ended_by?: string }} */ (
    result
  );
}

test("concurrent prompt and layout-warning writes do not lose prompts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const firstStore = new SessionStore(stateFile);
    const alternateStateFile = `${dir}/./state.json`;
    assert.notEqual(alternateStateFile, stateFile);
    const secondStore = new SessionStore(alternateStateFile);
    const session = await firstStore.upsertSession(artifact, "http://localhost:4387/session/test");
    const writes = [];
    for (let index = 0; index < 50; index += 1) {
      writes.push(
        firstStore.queuePrompts(session.key, {
          prompts: [
            {
              uid: String(index),
              prompt: `Prompt ${index}`,
              selector: "h1",
              tag: "h1",
              text: "Hello",
            },
          ],
        }),
        secondStore.recordLayoutWarnings(session.key, {
          layout_warnings: [
            {
              selector: `h1:nth-child(${index + 1})`,
              kind: "overlapping-text",
              overflowPx: index,
              viewportWidth: 720,
              severity: "error",
            },
          ],
        }),
      );
    }

    await Promise.all(writes);

    const updated = await firstStore.findByKey(session.key);
    assert.equal(updated.prompts.length, 50);
    assert.deepEqual(
      updated.prompts.map((prompt) => prompt.uid).sort((a, b) => Number(a) - Number(b)),
      Array.from({ length: 50 }, (_, index) => String(index)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("state remains parseable while large updates are written", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  let reader;
  let readerExit;
  try {
    const stateFile = path.join(dir, "state.json");
    const stopFile = path.join(dir, "stop");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const readerScript = `
      import { access, readFile } from "node:fs/promises";
      const [stateFile, stopFile] = process.argv.slice(1);
      let clean = 0;
      let torn = 0;
      process.stdout.write("ready\\n");
      while (true) {
        try {
          JSON.parse(await readFile(stateFile, "utf8"));
          clean += 1;
        } catch (error) {
          if (error instanceof SyntaxError) torn += 1;
          else if (error.code !== "ENOENT") throw error;
        }
        try {
          await access(stopFile);
          break;
        } catch {}
      }
      process.stdout.write(JSON.stringify({ clean, torn }));
    `;
    reader = spawn(process.execPath, ["--input-type=module", "-e", readerScript, stateFile, stopFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    readerExit = new Promise((resolve, reject) => {
      reader.once("error", reject);
      reader.once("exit", resolve);
    });
    let stdout = "";
    let stderr = "";
    reader.stdout.setEncoding("utf8");
    reader.stderr.setEncoding("utf8");
    reader.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    reader.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    await new Promise((resolve, reject) => {
      const onData = () => {
        if (stdout.includes("\n")) {
          reader.stdout.off("data", onData);
          resolve();
        }
      };
      reader.stdout.on("data", onData);
      reader.once("error", reject);
      reader.once("exit", (code) => {
        if (!stdout.includes("\n")) reject(new Error(`state reader exited early (${code}): ${stderr}`));
      });
    });

    const largeSnapshot = "x".repeat(200_000);
    for (let index = 0; index < 100; index += 1) {
      await store.queuePrompts(session.key, {
        prompts: [{ uid: String(index), prompt: `Prompt ${index}` }],
        dom_snapshot: `${index}:${largeSnapshot}`,
      });
      await store.takeFeedback(session.key);
    }
    await writeFile(stopFile, "");

    const exitCode = await readerExit;
    assert.equal(exitCode, 0, stderr);
    const counts = JSON.parse(stdout.slice(stdout.indexOf("\n") + 1));
    if (process.env.LAVISH_AXI_REPORT_ATOMIC_COUNTS) {
      console.log(`state reader counts: ${JSON.stringify(counts)}`);
    }
    assert.ok(counts.clean >= 100, `reader observed only ${counts.clean} clean state reads`);
    assert.equal(counts.torn, 0, `reader observed ${counts.torn} torn state writes`);
  } finally {
    if (reader && reader.exitCode === null) reader.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("no-op mutations neither create nor replace state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const emptyStore = new SessionStore(stateFile);
    assert.deepEqual(await emptyStore.takeFeedback("missing"), { status: "missing" });
    await assert.rejects(stat(stateFile), { code: "ENOENT" });

    const session = await emptyStore.upsertSession(artifact, "http://localhost:4387/session/test");
    const before = await stat(stateFile);
    assert.deepEqual(await emptyStore.takeFeedback(session.key), { status: "waiting" });
    assert.equal((await emptyStore.recordLayoutWarnings(session.key, {})).changed, false);
    assert.equal(await emptyStore.queuePrompts("missing", {}), null);
    assert.equal(await emptyStore.endSession("missing"), null);
    assert.equal(await emptyStore.addAgentReply("missing", "ignored"), null);
    const after = await stat(stateFile);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "atomic replacement preserves an existing state file mode",
  { skip: process.platform === "win32" && "POSIX file modes only" },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
    try {
      const stateFile = path.join(dir, "state.json");
      const artifact = path.join(dir, "artifact.html");
      await writeFile(artifact, "<h1>Hello</h1>");

      const store = new SessionStore(stateFile);
      const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
      await chmod(stateFile, 0o600);
      await store.addAgentReply(session.key, "Working on it");
      assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("queued prompts are returned with DOM snapshot context and then cleared", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" }],
    });

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.dom_snapshot, 'uid=1 h1 "Hello"');
    assert.deepEqual(first.prompts, [
      { uid: "1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" },
    ]);

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued text selection prompts preserve range anchors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<p id='intro'>Hello <strong>bright</strong> world</p>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const target = {
      type: "text-range",
      text: "lo bright wo",
      selector: "p#intro",
      start: { selector: "p#intro", path: [0], offset: 3 },
      end: { selector: "p#intro", path: [2], offset: 3 },
    };

    await store.queuePrompts(session.key, {
      prompts: [
        { uid: "", prompt: "Make this phrase punchier", selector: "p#intro", tag: "text", text: target.text, target },
      ],
    });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(result.prompts, [
      { uid: "", prompt: "Make this phrase punchier", selector: "p#intro", tag: "text", text: target.text, target },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued mermaid node prompts preserve node identity and drop unknown fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<div class='mermaid'>graph TD; A-->B;</div>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const target = {
      type: "mermaid-node",
      diagramId: "mermaid-7",
      nodeId: "flowchart-HomeAgentChat-3",
      label: "HomeAgentChat",
      selector: "svg#mermaid-7 > g > g.node",
      // A hostile/legacy field that must be stripped by the normalizer:
      injected: { nested: "should not survive" },
    };

    await store.queuePrompts(session.key, {
      prompts: [
        {
          uid: "",
          prompt: "This is where the orphan happens",
          selector: target.selector,
          tag: "mermaid-node",
          text: target.label,
          target,
        },
      ],
    });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(result.prompts.length, 1);
    assert.deepEqual(result.prompts[0].target, {
      type: "mermaid-node",
      diagramId: "mermaid-7",
      nodeId: "flowchart-HomeAgentChat-3",
      label: "HomeAgentChat",
      selector: "svg#mermaid-7 > g > g.node",
    });
    assert.equal(result.prompts[0].tag, "mermaid-node");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued whiteboard prompts normalize the excalidraw-scene target to its fixed shape", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<div class='mermaid'>graph TD; A-->B;</div>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");

    await store.queuePrompts(session.key, {
      prompts: [
        {
          uid: "",
          prompt: "Whiteboard edits:\nMoved rectangle (Auth)",
          selector: "",
          tag: "whiteboard",
          text: "Whiteboard edits",
          target: {
            type: "excalidraw-scene",
            diagramIndex: "1",
            diagramId: "mermaid-2",
            sourceHash: "abc123def4567890",
            scenePath: "/state/whiteboards/k/1.excalidraw",
            previewPath: "/state/whiteboards/k/1.png",
            imageFallback: false,
            stats: { added: 1, removed: 0, moved: 2, relabeled: 0, drawn: 1 },
            hostile: { nested: "should not survive" },
          },
        },
      ],
    });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(result.prompts.length, 1);
    assert.equal(result.prompts[0].tag, "whiteboard");
    assert.deepEqual(result.prompts[0].target, {
      type: "excalidraw-scene",
      kind: "mermaid",
      diagramIndex: 1,
      diagramId: "mermaid-2",
      sourceHash: "abc123def4567890",
      scenePath: "/state/whiteboards/k/1.excalidraw",
      previewPath: "/state/whiteboards/k/1.png",
      imageFallback: false,
      stats: { added: 1, removed: 0, moved: 2, relabeled: 0, drawn: 1 },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layout warnings are returned as feedback and then cleared", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const result = await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 24.5,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    });

    assert.equal(result.changed, true);
    assert.equal(result.hasWarnings, true);

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(first.prompts, []);
    assert.deepEqual(first.layout_warnings, [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 24.5,
        viewportWidth: 720,
        severity: "error",
        persistent: false,
      },
    ]);

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a warning re-reported after the agent already received it is marked persistent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const warning = {
      selector: "main > header > strong",
      kind: "overlapping-text",
      overflowPx: 0,
      viewportWidth: 720,
      severity: "warning",
    };

    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.layout_warnings[0].persistent, false);

    // Simulate a reload after an attempted fix that reports the identical finding again -
    // the agent already saw this exact selector+kind, so it should now read as a repeat.
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    const second = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(second.layout_warnings[0].persistent, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Two elements deep in the DOM can share a display selector, so `persistent` has to key on the
// browser's full identity. Keying on the selector alone told the agent it had already seen a
// finding it had never been shown.
test("findings sharing a display selector track persistence independently", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const shared = {
      selector: "div > div > div > div > pre",
      kind: "element-scroll-overflow",
      overflowPx: 24,
      viewportWidth: 720,
      severity: "error",
    };
    const first = { ...shared, identity: "html > body > div:nth-of-type(1) > div > div > div > div > pre" };
    const second = { ...shared, identity: "html > body > div:nth-of-type(2) > div > div > div > div > pre" };

    await store.recordLayoutWarnings(session.key, { layout_warnings: [first] });
    const delivered = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(delivered.layout_warnings.length, 1);
    assert.equal(delivered.layout_warnings[0].persistent, false);

    // Only the first element was ever shown to the agent. The second renders as the same
    // selector but is a different element the agent has never been told about.
    await store.recordLayoutWarnings(session.key, { layout_warnings: [first, second] });
    const repeat = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(
      repeat.layout_warnings.map((warning) => warning.persistent),
      [true, false],
      "the re-reported finding is persistent; its selector twin is still a fresh sighting",
    );
    assert.deepEqual(
      repeat.layout_warnings.map((warning) => warning.identity),
      [first.identity, second.identity],
      "identity reaches the agent intact, so it can tell the two apart too",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a warning is fresh again after a clean audit resolves it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const warning = {
      selector: "main > header > strong",
      kind: "overlapping-text",
      overflowPx: 0,
      viewportWidth: 720,
      severity: "warning",
    };

    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    await store.takeFeedback(session.key);
    const clean = await store.recordLayoutWarnings(session.key, { layout_warnings: [] });
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(clean.hasWarnings, false);
    assert.equal(result.layout_warnings[0].persistent, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistence memory survives reopening the same artifact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const warning = {
      selector: "main > header > strong",
      kind: "overlapping-text",
      overflowPx: 0,
      viewportWidth: 720,
      severity: "warning",
    };

    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    await store.takeFeedback(session.key);

    await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(result.layout_warnings[0].persistent, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reopening a session clears stale layout warnings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 24,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    });

    const reopened = await store.upsertSession(artifact, "http://localhost:4387/session/test");

    assert.equal(reopened.status, "open");
    assert.deepEqual(reopened.layout_warnings, []);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty layout warning reports clear pending warnings without waking feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 24,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    });
    const cleared = await store.recordLayoutWarnings(session.key, { layout_warnings: [] });

    assert.equal(cleared.changed, true);
    assert.equal(cleared.hasWarnings, false);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending a session makes feedback return ended", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key);

    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending a session defaults to agent-initiated and takeFeedback reports who ended it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const ended = await store.endSession(session.key);

    assert.equal(ended.ended_by, "agent");
    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
    assert.equal(result.ended_by, "agent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending a session as the user is recorded distinctly from an agent end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const ended = await store.endSession(session.key, "user");

    assert.equal(ended.ended_by, "user");
    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
    assert.equal(result.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent cleanup cannot overwrite an existing user end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key, "user");
    const ended = await store.endSession(session.key, "agent");

    assert.equal(ended.ended_by, "user");
    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
    assert.equal(result.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the final feedback batch before an end flags session_ended with who ended it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    // Browser send-and-end: prompts land first, then the session ends before delivery.
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "Freeform message" }],
    });
    await store.endSession(session.key, "user");

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.session_ended, true);
    assert.equal(first.ended_by, "user");

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
    assert.equal(second.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued prompts can atomically carry a browser end intent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      endSession: true,
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "Freeform message" }],
    });

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.session_ended, true);
    assert.equal(first.ended_by, "user");
    assert.equal(first.prompts.length, 1);

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
    assert.equal(second.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("late prompts after a user end preserve the ended session state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key, "user");
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "", prompt: "Late feedback", selector: "", tag: "message", text: "Freeform message" }],
    });

    const updated = await store.findByKey(session.key);
    assert.equal(updated.status, "ended");
    assert.equal(updated.ended_by, "user");

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.session_ended, true);
    assert.equal(first.ended_by, "user");
    assert.equal(first.prompts[0].prompt, "Late feedback");

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
    assert.equal(second.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("late layout warnings do not reopen ended sessions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key);
    await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 24,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    });

    const updated = await store.findByKey(session.key);
    assert.equal(updated.status, "ended");

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.layout_warnings.length, 1);
    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prompts queued before ending are still delivered before the ended status", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    // Browser send-and-end with no agent listening: prompts land first, then the session ends.
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "Freeform message" }],
    });
    await store.endSession(session.key);

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.prompts.length, 1);
    assert.equal(first.prompts[0].prompt, "Parting feedback");
    assert.equal(first.dom_snapshot, 'uid=1 h1 "Hello"');

    // Delivering the final batch must not resurrect the session.
    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent replies are stored in session chat history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.addAgentReply(session.key, "Applied the requested changes.");

    const updated = await store.findByKey(session.key);
    assert.deepEqual(
      updated.chat.map((item) => [item.role, item.text]),
      [["agent", "Applied the requested changes."]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("freeform user prompts are stored in session chat history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      prompts: [
        { uid: "", prompt: "Please make this clearer", selector: "", tag: "message", text: "Freeform message" },
      ],
    });

    const updated = await store.findByKey(session.key);
    assert.deepEqual(
      updated.chat.map((item) => [item.role, item.text]),
      [["user", "Please make this clearer"]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
