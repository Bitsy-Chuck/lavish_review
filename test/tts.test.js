import assert from "node:assert/strict";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_ELEVENLABS_VOICE,
  DEFAULT_GEMINI_VOICE,
  ReadAloudConfigError,
  ReadAloudJob,
  chooseEngine,
  describeRendering,
  mintGoogleAccessToken,
  narrationPrompt,
  openReadAloud,
  paragraphsFrom,
  pruneRenderings,
  readAloudStatus,
  resolveGoogleKeyFile,
  splitTextForTts,
  sseFrames,
  streamNarration,
  stripAudioTags,
  stripForNarration,
  stripId3,
  supportsAudioTags,
  synthesizeElevenLabs,
  synthesizeGeminiTts,
  ttsCacheHash,
  wavFromPcm,
} from "../src/tts.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(texts, { separator = "\r\n\r\n" } = {}) {
  const body = texts
    .map((text) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}${separator}`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function id3Tagged(payload, tagBytes = 35) {
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, tagBytes]);
  return Buffer.concat([header, Buffer.alloc(tagBytes, 0x20), payload]);
}

function mp3Response(payload) {
  return new Response(id3Tagged(payload), { status: 200, headers: { "content-type": "audio/mpeg" } });
}

function makeServiceAccountKey() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicKey,
    key: {
      type: "service_account",
      project_id: "proj-test",
      client_email: "reader@proj-test.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      token_uri: "https://oauth2.example/token",
    },
  };
}

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test("chooseEngine honors the forced engine and rejects unknown values", () => {
  assert.equal(chooseEngine({ LAVISH_AXI_TTS_ENGINE: "gemini", ELEVENLABS_API_KEY: "k" }), "gemini");
  assert.equal(chooseEngine({ LAVISH_AXI_TTS_ENGINE: "elevenlabs" }), "elevenlabs");
  assert.throws(() => chooseEngine({ LAVISH_AXI_TTS_ENGINE: "espeak" }), ReadAloudConfigError);
});

test("chooseEngine auto-picks ElevenLabs only when its key exists", () => {
  assert.equal(chooseEngine({ ELEVENLABS_API_KEY: "k" }), "elevenlabs");
  assert.equal(chooseEngine({}), "gemini");
});

test("resolveGoogleKeyFile takes an absolute path only when it exists", () => {
  const env = { GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json" };
  assert.equal(resolveGoogleKeyFile(env, { exists: (p) => p === "/keys/sa.json" }), "/keys/sa.json");
  assert.equal(resolveGoogleKeyFile(env, { exists: () => false }), null);
  assert.equal(resolveGoogleKeyFile({}, { exists: () => true }), null);
});

test("resolveGoogleKeyFile resolves a relative path against cwd, then home", () => {
  const env = { GOOGLE_APPLICATION_CREDENTIALS: "keys/sa.json" };
  const viaCwd = resolveGoogleKeyFile(env, {
    cwd: "/work",
    home: "/home/u",
    exists: (p) => p === path.resolve("/work", "keys/sa.json"),
  });
  assert.equal(viaCwd, path.resolve("/work", "keys/sa.json"));
  const viaHome = resolveGoogleKeyFile(env, {
    cwd: "/work",
    home: "/home/u",
    exists: (p) => p === path.resolve("/home/u", "keys/sa.json"),
  });
  assert.equal(viaHome, path.resolve("/home/u", "keys/sa.json"));
});

test("stripForNarration drops script, style, svg, and link markup but keeps Mermaid text", () => {
  const html =
    '<style>.x{}</style><script>alert(1)</script><svg><path d="M0 0"/></svg>' +
    '<link rel="stylesheet" href="a.css"><div class="mermaid">flowchart TD\nA --> B</div><p>Hello</p>';
  const stripped = stripForNarration(html);
  assert.ok(!stripped.includes("alert"));
  assert.ok(!stripped.includes(".x{}"));
  assert.ok(!stripped.includes("<svg"));
  assert.ok(!stripped.includes("<link"));
  assert.ok(stripped.includes("flowchart TD"));
  assert.ok(stripped.includes("<p>Hello</p>"));
});

test("stripForNarration keeps inline SVG only for diagrams", () => {
  const html = "<svg><title>Flow</title></svg><p>x</p>";
  assert.ok(!stripForNarration(html).includes("<svg"));
  assert.ok(stripForNarration(html, { keepSvg: true }).includes("<title>Flow</title>"));
});

test("audio tags are written only for v3 models and stripped for the others", () => {
  assert.equal(supportsAudioTags("eleven_v3"), true);
  assert.equal(supportsAudioTags("eleven_v3_conversational"), true);
  assert.equal(supportsAudioTags("eleven_flash_v2_5"), false);
  assert.equal(supportsAudioTags(""), false);
  assert.equal(stripAudioTags("[warm] Hello there. [pause] Next idea."), "Hello there. Next idea.");
  assert.equal(stripAudioTags("No tags [but brackets in 2026] stay"), "No tags [but brackets in 2026] stay");
  const tagged = narrationPrompt("<p>x</p>", { audioTags: true });
  assert.ok(tagged.includes("[curious]"));
  assert.ok(!narrationPrompt("<p>x</p>").includes("[curious]"));
  for (const kind of ["table", "diagram", "code"]) {
    assert.ok(narrationPrompt("<p>x</p>", { kind, audioTags: true }).includes("[pause]"), kind);
  }
});

test("narrationPrompt writes rules for each block kind and embeds the heading context", () => {
  const text = narrationPrompt("<p>Page</p>");
  assert.ok(text.includes("<p>Page</p>"));
  assert.ok(text.includes("Speak a heading as a short cue"));
  assert.ok(text.includes("blank line"));
  const table = narrationPrompt("<table></table>", { kind: "table", context: "Costs" });
  assert.ok(table.includes('The heading before it is: "Costs".'));
  assert.ok(table.includes("read each row as one natural sentence"));
  const diagram = narrationPrompt("<svg></svg>", { kind: "diagram" });
  assert.ok(diagram.includes("Mermaid text or SVG markup"));
  assert.ok(!diagram.includes("The heading before it"));
  const code = narrationPrompt("<pre>x</pre>", { kind: "code" });
  assert.ok(code.includes('Start with "Code block."'));
  assert.equal(narrationPrompt("<p>x</p>", { kind: "unknown" }), narrationPrompt("<p>x</p>"));
});

test("splitTextForTts keeps short text whole and splits long text on boundaries", () => {
  assert.deepEqual(splitTextForTts("short text", 100), ["short text"]);
  assert.deepEqual(splitTextForTts("", 100), []);
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} ends here.`).join(" ");
  const chunks = splitTextForTts(long, 300);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 300);
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "));
});

test("wavFromPcm writes a correct RIFF header for 16-bit mono PCM", () => {
  const pcm = Buffer.alloc(1000, 7);
  const wav = wavFromPcm(pcm, { sampleRate: 24_000 });
  assert.equal(wav.length, 44 + 1000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(28), 48_000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 1000);
});

test("ttsCacheHash changes with content, engine, voice, kind, context, and fixed narration", () => {
  const base = ttsCacheHash("<p>a</p>", "gemini", "Kore");
  assert.equal(base, ttsCacheHash("<p>a</p>", "gemini", "Kore"));
  assert.equal(base, ttsCacheHash("<p>a</p>", "gemini", "Kore", { kind: "text" }));
  assert.notEqual(base, ttsCacheHash("<p>b</p>", "gemini", "Kore"));
  assert.notEqual(base, ttsCacheHash("<p>a</p>", "elevenlabs", "Kore"));
  assert.notEqual(base, ttsCacheHash("<p>a</p>", "gemini", "Puck"));
  assert.notEqual(base, ttsCacheHash("<p>a</p>", "gemini", "Kore", { kind: "table" }));
  assert.notEqual(base, ttsCacheHash("<p>a</p>", "gemini", "Kore", { context: "Costs" }));
  assert.notEqual(base, ttsCacheHash("<p>a</p>", "gemini", "Kore", { narration: "Image." }));
  assert.notEqual(base, ttsCacheHash("<p>a</p>", "gemini", "Kore", { model: "eleven_v3" }));
});

test("describeRendering keys the file by the same hash under the cache directory", () => {
  const described = describeRendering("<p>a</p>", { cacheDir: "/cache/s1", env: {}, kind: "text" });
  assert.equal(described.engine, "gemini");
  assert.equal(described.voice, DEFAULT_GEMINI_VOICE);
  assert.equal(described.hash, ttsCacheHash("<p>a</p>", "gemini", DEFAULT_GEMINI_VOICE, { kind: "text" }));
  assert.equal(described.base, path.join("/cache/s1", described.hash));
});

test("stripId3 removes a leading tag and leaves plain audio alone", () => {
  const frame = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
  assert.deepEqual(stripId3(id3Tagged(frame)), frame);
  assert.deepEqual(stripId3(frame), frame);
  assert.deepEqual(stripId3(Buffer.from("ID")), Buffer.from("ID"));
});

test("mintGoogleAccessToken signs a verifiable JWT and returns the token", async () => {
  const { key, publicKey } = makeServiceAccountKey();
  const calls = [];
  const result = await mintGoogleAccessToken(key, {
    now: () => 1_000_000_000_000,
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: /** @type {URLSearchParams} */ (init.body) });
      return jsonResponse({ access_token: "tok-1", expires_in: 3600 });
    },
  });
  assert.equal(result.token, "tok-1");
  assert.equal(calls[0].url, "https://oauth2.example/token");
  const assertion = String(calls[0].body.get("assertion"));
  const [header, payload, signature] = assertion.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.iss, key.client_email);
  assert.equal(claims.aud, key.token_uri);
  const verified = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  assert.equal(verified, true);
});

test("sseFrames yields data payloads for carriage-return and plain framing", async () => {
  const crlf = new Response('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n').body;
  assert.deepEqual(await collect(sseFrames(crlf)), ['{"a":1}', '{"b":2}']);
  const lf = new Response(": comment\n\ndata: x\ndata: y\n\ndata: tail").body;
  assert.deepEqual(await collect(sseFrames(lf)), ["x\ny", "tail"]);
  assert.deepEqual(await collect(sseFrames(null)), []);
});

test("streamNarration posts the kind's prompt to the streaming endpoint and yields text pieces", async () => {
  const urls = [];
  const pieces = await collect(
    streamNarration("<table><tr><td>Hi</td></tr></table>", {
      token: "tok",
      project: "proj-test",
      kind: "table",
      context: "Costs",
      fetch: async (url, init) => {
        urls.push(String(url));
        const body = JSON.parse(String(init.body));
        const prompt = body.contents[0].parts[0].text;
        assert.ok(prompt.includes("<td>Hi</td>"));
        assert.ok(prompt.includes('The heading before it is: "Costs".'));
        assert.ok(!prompt.includes("[curious]"), "no tags unless asked");
        assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
        return sseResponse(["Hello. ", "World."]);
      },
    }),
  );
  assert.deepEqual(pieces, ["Hello. ", "World."]);
  assert.ok(urls[0].includes("/projects/proj-test/locations/global/"));
  assert.ok(urls[0].endsWith("gemini-3.5-flash:streamGenerateContent?alt=sse"));
});

test("streamNarration fails on an HTTP error or an empty stream", async () => {
  await assert.rejects(
    collect(
      streamNarration("<p>x</p>", {
        token: "t",
        project: "p",
        fetch: async () => jsonResponse({ error: { message: "quota" } }, 429),
      }),
    ),
    /Vertex gemini-3\.5-flash failed: HTTP 429: quota/,
  );
  await assert.rejects(
    collect(streamNarration("<p>x</p>", { token: "t", project: "p", fetch: async () => sseResponse([]) })),
    /returned no text/,
  );
});

test("paragraphsFrom cuts on blank lines and splits oversized paragraphs", async () => {
  async function* pieces() {
    yield "First para";
    yield "graph.\n\nSecond";
    yield " one.\n \nThird.";
  }
  assert.deepEqual(await collect(paragraphsFrom(pieces())), ["First paragraph.", "Second one.", "Third."]);
  async function* huge() {
    yield Array.from({ length: 80 }, (_, i) => `Sentence ${i} is here.`).join(" ");
  }
  const parts = await collect(paragraphsFrom(huge()));
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 1200);
});

test("synthesizeElevenLabs posts to the voice endpoint with expressive settings and returns tag-free MP3 bytes", async () => {
  const result = await synthesizeElevenLabs("[warm] Say hi", {
    apiKey: "el-key",
    fetch: async (url, init) => {
      assert.ok(String(url).includes(`/v1/text-to-speech/${DEFAULT_ELEVENLABS_VOICE}?`));
      assert.equal(init.headers["xi-api-key"], "el-key");
      const body = JSON.parse(String(init.body));
      assert.equal(body.text, "[warm] Say hi", "v3 keeps the tag");
      assert.equal(body.model_id, "eleven_v3");
      assert.deepEqual(body.voice_settings, {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true,
      });
      return mp3Response(Buffer.from("mp3data"));
    },
  });
  await synthesizeElevenLabs("[warm] Say hi", {
    apiKey: "el-key",
    model: "eleven_flash_v2_5",
    fetch: async (url, init) => {
      assert.equal(JSON.parse(String(init.body)).text, "Say hi", "Flash would read the tag aloud, so it is removed");
      return mp3Response(Buffer.from("x"));
    },
  });
  assert.equal(result.mime, "audio/mpeg");
  assert.equal(result.ext, "mp3");
  assert.equal(result.audio.toString(), "mp3data");
});

test("synthesizeElevenLabs surfaces the provider error detail", async () => {
  await assert.rejects(
    synthesizeElevenLabs("Say hi", {
      apiKey: "el-key",
      fetch: async () => jsonResponse({ detail: { message: "quota exceeded" } }, 402),
    }),
    /ElevenLabs synthesis failed: HTTP 402: quota exceeded/,
  );
});

test("synthesizeGeminiTts chunks long text and wraps the joined PCM as WAV", async () => {
  const pcmChunk = Buffer.alloc(10, 3).toString("base64");
  let calls = 0;
  const long = Array.from({ length: 400 }, (_, i) => `Sentence ${i} is here.`).join(" ");
  const result = await synthesizeGeminiTts(long, {
    token: "tok",
    project: "proj-test",
    fetch: async (url) => {
      calls += 1;
      assert.ok(String(url).includes("gemini-2.5-flash-tts:generateContent"));
      return jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { data: pcmChunk } }] } }] });
    },
  });
  assert.ok(calls > 1);
  assert.equal(result.mime, "audio/wav");
  assert.equal(result.audio.length, 44 + calls * 10);
});

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-tts-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function routedFetch(routes, log = []) {
  return async (url, init) => {
    log.push(String(url));
    for (const [needle, handler] of routes) {
      if (String(url).includes(needle)) return handler(url, init);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

async function fixture(dir, env = {}) {
  const { key } = makeServiceAccountKey();
  const keyFile = path.join(dir, "sa.json");
  await writeFile(keyFile, JSON.stringify(key));
  return { env: { GOOGLE_APPLICATION_CREDENTIALS: keyFile, ...env } };
}

function finished(job) {
  return new Promise((resolve) => {
    if (job.state !== "running") resolve();
    job.on("end", resolve);
    job.on("failed", resolve);
  });
}

test("openReadAloud streams paragraphs as audio, caches the file, and serves it next time", async () => {
  await withTempDir(async (dir) => {
    const { env } = await fixture(dir, { ELEVENLABS_API_KEY: "el" });
    let voiced = 0;
    const log = [];
    const fetchImpl = routedFetch(
      [
        ["oauth2.example", () => jsonResponse({ access_token: "tok", expires_in: 3600 })],
        [
          "gemini-3.5-flash:streamGenerateContent",
          (url, init) => {
            const prompt = JSON.parse(String(init.body)).contents[0].parts[0].text;
            assert.ok(prompt.includes("[curious]"), "ElevenLabs on v3 asks for audio tags");
            return sseResponse(["Para one.", "\n\nPara ", "two."]);
          },
        ],
        [
          "api.elevenlabs.io",
          (url, init) => {
            voiced += 1;
            const text = JSON.parse(String(init.body)).text;
            return mp3Response(Buffer.from(text === "Para one." ? "AAA" : "BB"));
          },
        ],
      ],
      log,
    );
    const options = {
      cacheDir: path.join(dir, "sess"),
      env,
      fetch: fetchImpl,
      tokens: new Map(),
      jobs: new Map(),
    };

    const opened = await openReadAloud("<p>v1</p>", options);
    assert.equal(opened.kind, "job");
    const { job } = opened;
    const received = [];
    job.on("chunk", (chunk) => received.push(chunk.toString()));
    assert.equal(job.mime, "audio/mpeg");
    assert.deepEqual((await readAloudStatus("<p>v1</p>", options)).state, "running");

    await job.ready;
    assert.equal(job.state, "running", "ready fires at the first chunk, before the end");
    assert.deepEqual(received, ["AAA"]);
    await finished(job);
    assert.equal(job.state, "done");
    assert.deepEqual(received, ["AAA", "BB"]);
    assert.equal(voiced, 2);
    assert.equal(job.paragraphs, 2);
    assert.equal(job.narration, "Para one.\n\nPara two.");
    assert.equal((await readFile(job.file)).toString(), "AAABB");
    const meta = JSON.parse(await readFile(job.file.replace(/\.mp3$/, ".json"), "utf8"));
    assert.equal(meta.engine, "elevenlabs");
    assert.equal(meta.voice, DEFAULT_ELEVENLABS_VOICE);
    assert.equal(meta.chars, job.narration.length);
    assert.equal(options.jobs.size, 0, "a finished job leaves the running set");

    const callsBefore = log.length;
    const again = await openReadAloud("<p>v1</p>", options);
    assert.equal(again.kind, "file");
    assert.equal(again.file, job.file);
    assert.equal(log.length, callsBefore, "a cache hit makes no network calls");
    const status = await readAloudStatus("<p>v1</p>", options);
    assert.equal(status.state, "done");
    assert.equal(status.cached, true);

    const third = await openReadAloud("<p>v2</p>", options);
    assert.equal(third.kind, "job");
    await finished(third.job);
    const names = await readdir(options.cacheDir);
    assert.ok(names.includes(path.basename(job.file)), "each block keeps its own rendering");
    assert.ok(names.includes(path.basename(third.job.file)));
    const removed = await pruneRenderings(options.cacheDir, [third.job.hash], { jobs: options.jobs });
    assert.equal(removed, 2, "the stale block's audio and sidecar are gone");
    assert.deepEqual((await readdir(options.cacheDir)).sort(), [`${third.job.hash}.json`, `${third.job.hash}.mp3`]);
  });
});

test("pruneRenderings keeps files of running jobs and tolerates a missing directory", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "keep.mp3"), "a");
    await writeFile(path.join(dir, "keep.json"), "{}");
    await writeFile(path.join(dir, "running.mp3.part"), "b");
    await writeFile(path.join(dir, "old.mp3"), "c");
    const jobs = new Map([
      [path.join(dir, "running"), new ReadAloudJob({ hash: "running", engine: "elevenlabs", voice: "v" })],
    ]);
    assert.equal(await pruneRenderings(dir, ["keep"], { jobs }), 1);
    assert.deepEqual((await readdir(dir)).sort(), ["keep.json", "keep.mp3", "running.mp3.part"]);
    assert.equal(await pruneRenderings(path.join(dir, "missing"), []), 0);
  });
});

test("openReadAloud hands concurrent listeners the same running job", async () => {
  await withTempDir(async (dir) => {
    const { env } = await fixture(dir, { ELEVENLABS_API_KEY: "el" });
    const fetchImpl = routedFetch([
      ["oauth2.example", () => jsonResponse({ access_token: "tok", expires_in: 3600 })],
      ["gemini-3.5-flash:streamGenerateContent", () => sseResponse(["Only paragraph."])],
      ["api.elevenlabs.io", () => mp3Response(Buffer.from("X"))],
    ]);
    const options = { cacheDir: dir, env, fetch: fetchImpl, tokens: new Map(), jobs: new Map() };
    const first = await openReadAloud("<p>x</p>", options);
    const second = await openReadAloud("<p>x</p>", options);
    assert.equal(first.kind, "job");
    assert.equal(second.kind, "job");
    assert.equal(second.job, first.job);
    await finished(first.job);
    assert.equal(first.job.state, "done");
  });
});

test("openReadAloud falls back to Gemini TTS when ElevenLabs fails before any audio", async () => {
  await withTempDir(async (dir) => {
    const { env } = await fixture(dir, { ELEVENLABS_API_KEY: "el" });
    const pcm = Buffer.alloc(8, 1).toString("base64");
    const fetchImpl = routedFetch([
      ["oauth2.example", () => jsonResponse({ access_token: "tok", expires_in: 3600 })],
      ["gemini-3.5-flash:streamGenerateContent", () => sseResponse(["[warm] One.\n\n[pause] Two."])],
      ["api.elevenlabs.io", () => jsonResponse({ detail: "quota exceeded" }, 402)],
      [
        "gemini-2.5-flash-tts:",
        (url, init) => {
          const text = JSON.parse(String(init.body)).contents[0].parts[0].text;
          assert.ok(!text.includes("["), `Gemini TTS must not see tags: ${text}`);
          return jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { data: pcm } }] } }] });
        },
      ],
    ]);
    const options = { cacheDir: dir, env, fetch: fetchImpl, tokens: new Map(), jobs: new Map() };
    const { job } = /** @type {{ job: ReadAloudJob }} */ (await openReadAloud("<p>page</p>", options));
    assert.ok(job instanceof ReadAloudJob);
    await finished(job);
    assert.equal(job.state, "done");
    assert.equal(job.engine, "gemini");
    assert.equal(job.voice, DEFAULT_GEMINI_VOICE);
    assert.equal(job.mime, "audio/wav");
    assert.match(String(job.fallback), /quota exceeded/);
    const audio = await readFile(job.file);
    assert.equal(audio.toString("ascii", 0, 4), "RIFF");
    assert.equal(audio.length, 44 + 16);
  });
});

test("openReadAloud ends the job with the provider error after audio has started", async () => {
  await withTempDir(async (dir) => {
    const { env } = await fixture(dir, { ELEVENLABS_API_KEY: "el" });
    let calls = 0;
    const fetchImpl = routedFetch([
      ["oauth2.example", () => jsonResponse({ access_token: "tok", expires_in: 3600 })],
      ["gemini-3.5-flash:streamGenerateContent", () => sseResponse(["One.\n\nTwo."])],
      [
        "api.elevenlabs.io",
        () => (calls++ === 0 ? mp3Response(Buffer.from("A")) : jsonResponse({ detail: "boom" }, 500)),
      ],
    ]);
    const options = { cacheDir: dir, env, fetch: fetchImpl, tokens: new Map(), jobs: new Map() };
    const { job } = /** @type {{ job: ReadAloudJob }} */ (await openReadAloud("<p>page</p>", options));
    await finished(job);
    assert.equal(job.state, "error");
    assert.match(String(job.error), /HTTP 500: boom/);
    assert.equal(job.status().state, "error");
    assert.deepEqual(await readdir(dir), ["sa.json"], "a failed job writes no cache entry");
  });
});

test("openReadAloud raises a config error without Google credentials", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      openReadAloud("<p>page</p>", { cacheDir: dir, env: {}, jobs: new Map() }),
      ReadAloudConfigError,
    );
    assert.equal((await readAloudStatus("<p>page</p>", { cacheDir: dir, env: {}, jobs: new Map() })).state, "idle");
  });
});

test("an image block is voiced from its fixed narration without the narration model", async () => {
  await withTempDir(async (dir) => {
    const { env } = await fixture(dir, { ELEVENLABS_API_KEY: "el" });
    const log = [];
    const fetchImpl = routedFetch(
      [
        ["oauth2.example", () => jsonResponse({ access_token: "tok", expires_in: 3600 })],
        [
          "api.elevenlabs.io",
          (url, init) => {
            assert.equal(JSON.parse(String(init.body)).text, "Image: Cost chart.");
            return mp3Response(Buffer.from("IMG"));
          },
        ],
      ],
      log,
    );
    const options = {
      cacheDir: dir,
      kind: "image",
      narration: "Image: Cost chart.",
      env,
      fetch: fetchImpl,
      tokens: new Map(),
      jobs: new Map(),
    };
    const { job } = /** @type {{ job: ReadAloudJob }} */ (await openReadAloud('<img alt="Cost chart">', options));
    await finished(job);
    assert.equal(job.state, "done");
    assert.equal(job.narration, "Image: Cost chart.");
    assert.ok(!log.some((url) => url.includes("streamGenerateContent")), "no narration model call");
  });
});

test("an image block on ElevenLabs needs no Google key at all", async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = routedFetch([["api.elevenlabs.io", () => mp3Response(Buffer.from("IMG"))]]);
    const options = {
      cacheDir: dir,
      kind: "image",
      narration: "Image.",
      env: { ELEVENLABS_API_KEY: "el" },
      fetch: fetchImpl,
      tokens: new Map(),
      jobs: new Map(),
    };
    const { job } = /** @type {{ job: ReadAloudJob }} */ (await openReadAloud("<img>", options));
    await finished(job);
    assert.equal(job.state, "done");
  });
});
