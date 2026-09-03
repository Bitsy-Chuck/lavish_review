import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";
// Read-aloud resolves credentials from the environment; scrub them so these
// tests exercise the unconfigured paths deterministically. node --test runs
// each file in its own process, so this cannot leak into other test files.
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.ELEVENLABS_API_KEY;
delete process.env.LAVISH_AXI_TTS_ENGINE;

import { serve } from "../src/server.js";
import { ReadAloudJob } from "../src/tts.js";

const ARTIFACT =
  "<!doctype html><html><body><h1>Title</h1><p>Readable text.</p>" +
  '<table><tr><th>A</th></tr><tr><td>1</td></tr></table><img src="x.png" alt="Cost chart"></body></html>';

async function startSession(run, serveOptions = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-tts-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, ARTIFACT);
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    ...serveOptions,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await res.json();
    await run({ base, session, dir, artifact, sameOrigin: { referer: `${base}/session/${session.key}` } });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @returns {any} A stand-in for the read-aloud module, loosely typed on purpose. */
function fakeReadAloud(overrides = {}) {
  return {
    open: async () => {
      throw new Error("open not expected");
    },
    status: async () => ({ state: "idle" }),
    prune: async () => 0,
    describe: (html) => ({ hash: `h-${html.length}` }),
    ...overrides,
  };
}

test("the chrome bar carries the Listen button and the served artifact carries block tags", async () => {
  await startSession(async ({ base, session }) => {
    const chrome = await (await fetch(`${base}/session/${session.key}`)).text();
    assert.match(chrome, /id="listen"/);
    assert.match(chrome, /id="listenLabel"/);
    const artifact = await (await fetch(`${base}/artifact/${session.key}/index.html`)).text();
    assert.match(artifact, /<h1 data-lavish-block="0" data-lavish-block-kind="text">Title<\/h1>/);
    assert.match(artifact, /<table data-lavish-block="1" data-lavish-block-kind="table">/);
    assert.match(artifact, /<img data-lavish-block="2" data-lavish-block-kind="image" src="x.png"/);
    assert.match(artifact, /\/sdk\.js\?key=/);
  });
});

test("the block manifest lists blocks and prunes renderings the page no longer has", async () => {
  const pruned = [];
  const readAloud = fakeReadAloud({
    prune: async (dir, keep) => {
      pruned.push({ dir, keep: [...keep] });
      return 0;
    },
  });
  await startSession(
    async ({ base, session, dir }) => {
      const res = await fetch(`${base}/api/${session.key}/tts/blocks`);
      assert.equal(res.status, 200);
      const manifest = await res.json();
      assert.match(manifest.version, /^[0-9a-f]{12}$/);
      assert.deepEqual(
        manifest.blocks.map((block) => [block.index, block.kind, block.label]),
        [
          [0, "text", "Title Readable text."],
          [1, "table", "Table"],
          [2, "image", "Image"],
        ],
      );
      assert.equal(manifest.blocks[0].chars, "Title Readable text.".length);
      assert.equal(pruned.length, 1);
      assert.equal(pruned[0].dir, path.join(dir, "tts", session.key));
      assert.equal(pruned[0].keep.length, 3);
    },
    { readAloud },
  );
});

test("block audio rejects cross-origin requests and accepts fetch metadata", async () => {
  await startSession(async ({ base, session }) => {
    assert.equal((await fetch(`${base}/api/${session.key}/tts/block/0/audio`)).status, 403);
    const viaMetadata = await fetch(`${base}/api/${session.key}/tts/block/0/audio`, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    assert.equal(viaMetadata.status, 503, "same-origin by fetch metadata reaches the handler");
  });
});

test("block audio reports missing credentials as a 503 config error", async () => {
  await startSession(async ({ base, session, sameOrigin }) => {
    const res = await fetch(`${base}/api/${session.key}/tts/block/0/audio`, { headers: sameOrigin });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /GOOGLE_APPLICATION_CREDENTIALS/);
  });
});

test("block audio answers 404 for a missing block and 409 for a stale page version", async () => {
  await startSession(async ({ base, session, sameOrigin }) => {
    assert.equal((await fetch(`${base}/api/${session.key}/tts/block/9/audio`, { headers: sameOrigin })).status, 404);
    assert.equal((await fetch(`${base}/api/${session.key}/tts/block/x/audio`, { headers: sameOrigin })).status, 404);
    const stale = await fetch(`${base}/api/${session.key}/tts/block/0/audio?v=000000000000`, { headers: sameOrigin });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).version, /^[0-9a-f]{12}$/);
  });
});

test("block status is idle before any rendering exists", async () => {
  await startSession(
    async ({ base, session }) => {
      const res = await fetch(`${base}/api/${session.key}/tts/block/1/status`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).state, "idle");
    },
    { readAloud: fakeReadAloud() },
  );
});

test("block audio streams a running job and passes the block's kind, context, and image narration", async () => {
  const job = new ReadAloudJob({ hash: "h1", engine: "elevenlabs", voice: "v" });
  const opened = [];
  const readAloud = fakeReadAloud({
    open: async (html, options) => {
      opened.push({ html, options });
      return { kind: "job", job };
    },
    status: async () => job.status(),
  });
  await startSession(
    async ({ base, session, dir, sameOrigin }) => {
      const request = fetch(`${base}/api/${session.key}/tts/block/2/audio`, { headers: sameOrigin });
      await sleep(30);
      job.push(Buffer.from("AB"));
      const res = await request;
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "audio/mpeg");
      assert.equal(res.headers.get("accept-ranges"), "none");
      await sleep(30);
      job.push(Buffer.from("CD"));
      await sleep(30);
      const file = path.join(dir, "h1.mp3");
      await writeFile(file, "ABCD");
      job.finish(file);
      assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "ABCD");
      assert.equal(opened.length, 1);
      assert.match(opened[0].html, /^<img src="x.png" alt="Cost chart">$/);
      assert.equal(opened[0].options.kind, "image");
      assert.equal(opened[0].options.narration, "Image: Cost chart.");
      assert.equal(opened[0].options.cacheDir, path.join(dir, "tts", session.key));
      assert.equal((await (await fetch(`${base}/api/${session.key}/tts/block/2/status`)).json()).state, "done");
    },
    { readAloud },
  );
});

test("block audio serves a finished rendering with range support, even under a dot directory", async () => {
  await startSession(async ({ session, dir }) => {
    // The real cache sits under ~/.lavish-axi, a dot directory: the sender must not 404 on it.
    const cacheDir = path.join(dir, ".lavish-axi", "tts");
    await mkdir(cacheDir, { recursive: true });
    const file = path.join(cacheDir, "done.mp3");
    await writeFile(file, "ABCDEFGH");
    const server = await serve({
      port: 0,
      stateFile: path.join(dir, "state.json"),
      version: "9.9.9-test",
      readAloud: fakeReadAloud({
        open: async () => ({
          kind: "file",
          file,
          mime: "audio/mpeg",
          hash: "d1",
          engine: "elevenlabs",
          voice: "v",
          chars: 8,
        }),
      }),
    });
    try {
      const base2 = `http://127.0.0.1:${server.port}`;
      const referer = { referer: `${base2}/session/${session.key}` };
      const full = await fetch(`${base2}/api/${session.key}/tts/block/1/audio`, { headers: referer });
      assert.equal(full.status, 200);
      assert.equal(full.headers.get("content-type"), "audio/mpeg");
      assert.equal(await full.text(), "ABCDEFGH");
      const part = await fetch(`${base2}/api/${session.key}/tts/block/1/audio`, {
        headers: { ...referer, range: "bytes=2-3" },
      });
      assert.equal(part.status, 206);
      assert.equal(await part.text(), "CD");
    } finally {
      await server.close();
    }
  });
});

test("block audio answers 502 when the job fails before any audio", async () => {
  const job = new ReadAloudJob({ hash: "h2", engine: "elevenlabs", voice: "v" });
  const readAloud = fakeReadAloud({ open: async () => ({ kind: "job", job }), status: async () => job.status() });
  await startSession(
    async ({ base, session, sameOrigin }) => {
      const request = fetch(`${base}/api/${session.key}/tts/block/0/audio`, { headers: sameOrigin });
      await sleep(30);
      job.fail(new Error("narration model returned no text"));
      const res = await request;
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /returned no text/);
      assert.equal((await (await fetch(`${base}/api/${session.key}/tts/block/0/status`)).json()).state, "error");
    },
    { readAloud },
  );
});
