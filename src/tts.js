// Read-aloud pipeline: turn one block of an artifact into speech, streamed.
//
// A rendering runs as a job:
// 1. Narration - Gemini on Vertex AI reads the block's HTML and streams a
//    narration script written for the block's kind: prose stays close to the
//    author's words, a table becomes spoken sentences, a Mermaid source
//    becomes a plain-word walk-through, a code block becomes a short
//    description. An image needs no model: its narration is a fixed sentence.
// 2. Synthesis - each finished paragraph is voiced at once: ElevenLabs by
//    default (MP3 pieces, ID3 tags stripped so they join into one stream),
//    or Gemini TTS on Vertex through the same service account (one WAV at
//    the end, because a WAV header needs the final length).
//
// Listeners subscribe to the job and receive the audio as it is produced, so
// playback starts after the first paragraph instead of after the whole page.
// The finished audio lands in the session's cache directory under a hash of
// the block content plus engine and voice, so a replay costs nothing and an
// edit re-voices only the blocks that changed.

import { createHash, createSign } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const NARRATION_MODEL = "gemini-3.5-flash";
export const GEMINI_TTS_MODEL = "gemini-2.5-flash-tts";
export const DEFAULT_ELEVENLABS_VOICE = "JBFqnCBsd6RMkjVDRZzb"; // "George", a warm narrator.
// Eleven v3 understands audio tags such as [warm] or [pause] and speaks with
// emotion; the Flash and Turbo models read those tags aloud as words, so the
// narration prompt only writes tags when the model can use them.
export const DEFAULT_ELEVENLABS_MODEL = "eleven_v3";
export const ELEVENLABS_VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true };

/** True when an ElevenLabs model id understands v3 audio tags. */
export function supportsAudioTags(model) {
  // "eleven_v3" and "eleven_v3_conversational"; \b would not stop at the underscore.
  return /^eleven_v3(?:_|$)/.test(String(model || ""));
}
export const DEFAULT_GEMINI_VOICE = "Kore";
const GEMINI_TTS_SAMPLE_RATE = 24_000;
const GOOGLE_TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const REQUEST_TIMEOUT_MS = 120_000;
// A long page narrates for minutes; the stream is watched as a whole.
const NARRATION_TIMEOUT_MS = 900_000;
const MAX_HTML_CHARS = 300_000;
const MAX_PARAGRAPH_CHARS = 1_200;
const GEMINI_TTS_CHUNK_CHARS = 3_500;
// Part of the cache key: bump when the narration prompt changes meaningfully,
// so already-rendered pages pick the improvement up on their next play.
const NARRATION_PROMPT_VERSION = 4;

/** Raised when read-aloud lacks configuration, as opposed to a provider failure. */
export class ReadAloudConfigError extends Error {}

/**
 * Pick the synthesis engine from the environment.
 * `LAVISH_AXI_TTS_ENGINE` forces `elevenlabs` or `gemini`; unset means auto:
 * ElevenLabs when its key exists, otherwise Gemini TTS.
 * @param {NodeJS.ProcessEnv} env
 * @returns {"elevenlabs" | "gemini"}
 */
export function chooseEngine(env) {
  const forced = String(env.LAVISH_AXI_TTS_ENGINE || "")
    .trim()
    .toLowerCase();
  if (forced === "elevenlabs" || forced === "gemini") return forced;
  if (forced) throw new ReadAloudConfigError(`unknown LAVISH_AXI_TTS_ENGINE "${forced}"`);
  return env.ELEVENLABS_API_KEY ? "elevenlabs" : "gemini";
}

/**
 * Resolve the Google service-account key file path.
 * An absolute `GOOGLE_APPLICATION_CREDENTIALS` wins. A relative one is tried
 * against the working directory, then against the home directory.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ cwd?: string, home?: string, exists?: (p: string) => boolean }} [options]
 * @returns {string | null} An existing key file path, or null.
 */
export function resolveGoogleKeyFile(env, options = {}) {
  const raw = String(env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
  if (!raw) return null;
  const exists = options.exists || existsSync;
  if (path.isAbsolute(raw)) return exists(raw) ? raw : null;
  for (const base of [options.cwd || process.cwd(), options.home ?? os.homedir()]) {
    if (!base) continue;
    const candidate = path.resolve(base, raw);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Remove markup that only wastes narration-model tokens.
 * Scripts, styles, and inline SVG carry no readable content - the Mermaid
 * sources (plain text in the DOM) survive and describe the diagrams better
 * than their rendered SVG ever could.
 * @param {string} html
 */
export function stripForNarration(html, { keepSvg = false } = {}) {
  let text = String(html ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");
  if (!keepSvg) text = text.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "");
  return text.slice(0, MAX_HTML_CHARS);
}

const TAG_RULE =
  "- Make it sound alive: put a short audio tag in square brackets before a sentence when the delivery should change, " +
  "such as [curious], [warm], [serious], [excited], [thoughtful], or [pause] between ideas. Use at most one tag per sentence, " +
  "and none on plain fact sentences. Never invent other tag words, and never put a tag inside a sentence.";

const NARRATION_COMMON = [
  "- Say numbers, units, and abbreviations the way a person would say them.",
  "- Do not add opinions or content that is not in the fragment. Do not mention HTML or that this is a web page.",
  "- Output plain text only, in the page's language: no markdown, no lists, no stage directions.",
];

/**
 * Build the narration instruction for one block of a page.
 * @param {string} html Already stripped block HTML.
 * @param {{ kind?: string, context?: string, audioTags?: boolean }} [options] `audioTags` asks for v3 delivery tags.
 */
export function narrationPrompt(html, { kind = "text", context = "", audioTags = false } = {}) {
  const heading = context ? `The heading before it is: "${context}".` : "";
  const tags = audioTags ? TAG_RULE : "";
  const rules = {
    text: [
      "Turn this HTML fragment, one part of a longer page, into a narration script for text-to-speech.",
      "Rules:",
      "- Keep the author's words for prose; adjust only what sounds wrong when spoken.",
      '- Speak a heading as a short cue, like "Section: build plan."',
      "- Skip buttons, forms, input controls, and icons.",
      "- Do not add an introduction or a closing: the fragment continues the page.",
      tags,
      ...NARRATION_COMMON,
      "- Write short paragraphs of a few sentences each, separated by one blank line.",
    ],
    table: [
      "Turn this HTML table, one part of a longer page, into a narration script for text-to-speech.",
      heading,
      "Rules:",
      "- First say in one sentence what the table shows.",
      "- Then read each row as one natural sentence that uses the column headers as phrasing. Keep every fact and every number.",
      "- Do not add a closing.",
      tags,
      ...NARRATION_COMMON,
      "- Put a blank line after the first sentence and after every three rows.",
    ],
    diagram: [
      "Describe this diagram, one part of a longer page, for a listener who cannot see it. The source is Mermaid text or SVG markup.",
      heading,
      "Rules:",
      "- Start with the diagram's title or description when it has one; otherwise say what kind of diagram it is and what it shows.",
      "- Then walk through it step by step in plain words: the parts and how they connect, in the order a reader follows.",
      "- Do not read syntax, identifiers, or coordinates.",
      tags,
      ...NARRATION_COMMON,
      "- Keep it to a few short paragraphs, separated by one blank line.",
    ],
    code: [
      "Describe this code block, one part of a longer page, for a listener.",
      heading,
      "Rules:",
      '- Start with "Code block." Then say in at most two sentences what the code does or shows, and name the language or tool when it is clear.',
      "- Do not read the code itself.",
      tags,
      ...NARRATION_COMMON,
    ],
  };
  return [...(rules[kind] || rules.text).filter(Boolean), "", "HTML:", html].join("\n");
}

/**
 * Mint a Google OAuth access token from a service-account key, with no SDK.
 * @param {{ client_email: string, private_key: string, token_uri?: string }} key
 * @param {{ fetch?: typeof fetch, now?: () => number }} [options]
 * @returns {Promise<{ token: string, expiresAt: number }>}
 */
export async function mintGoogleAccessToken(key, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const nowSeconds = Math.floor((options.now ? options.now() : Date.now()) / 1000);
  const tokenUri = key.token_uri || "https://oauth2.googleapis.com/token";
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned =
    encode({ alg: "RS256", typ: "JWT" }) +
    "." +
    encode({
      iss: key.client_email,
      scope: GOOGLE_TOKEN_SCOPE,
      aud: tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    });
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const response = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const data = await readJson(response, "Google token exchange");
  const token = String(data.access_token || "");
  if (!token) throw new Error("Google token exchange returned no access_token");
  return { token, expiresAt: (nowSeconds + Number(data.expires_in || 3600) - 60) * 1000 };
}

/**
 * Stream the narration script for one block from Gemini on Vertex AI.
 * Yields text pieces as the model produces them.
 * @param {string} html Raw block HTML.
 * @param {{ token: string, project: string, fetch?: typeof fetch, model?: string, kind?: string, context?: string, audioTags?: boolean }} options
 * @returns {AsyncGenerator<string>}
 */
export async function* streamNarration(html, options) {
  const fetchImpl = options.fetch || fetch;
  const model = options.model || NARRATION_MODEL;
  const kind = options.kind || "text";
  const prompt = narrationPrompt(stripForNarration(html, { keepSvg: kind === "diagram" }), {
    kind,
    context: options.context || "",
    audioTags: Boolean(options.audioTags),
  });
  const url = `${vertexModelUrl(options.project, model)}:streamGenerateContent?alt=sse`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NARRATION_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // Narration is a rewrite, not reasoning. With default thinking the first
        // paragraph of a long page arrives after half a minute; minimal thinking
        // brings it under a second.
        generationConfig: { temperature: 0.3, thinkingConfig: { thinkingLevel: "minimal" } },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Vertex ${model} failed: ${await describeHttpError(response)}`);
    let produced = 0;
    for await (const frame of sseFrames(response.body)) {
      let event;
      try {
        event = JSON.parse(frame);
      } catch {
        continue;
      }
      const parts = event?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((part) => String(part.text || "")).join("");
      if (text) {
        produced += text.length;
        yield text;
      }
    }
    if (!produced) throw new Error("narration model returned no text");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("narration stream timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Split a server-sent-events body into the `data:` payload of each frame.
 * Vertex ends frames with a carriage-return pair; plain newlines work too.
 * @param {AsyncIterable<Uint8Array> | null} body
 * @returns {AsyncGenerator<string>}
 */
export async function* sseFrames(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = function* (frame) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (data.length) yield data.join("\n");
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield* emit(frame);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* emit(buffer);
}

/**
 * Turn a stream of text pieces into complete paragraphs, each short enough
 * to voice as one request. A paragraph ends at a blank line; an oversized
 * paragraph is cut at sentence ends.
 * @param {AsyncIterable<string>} pieces
 * @returns {AsyncGenerator<string>}
 */
export async function* paragraphsFrom(pieces) {
  let buffer = "";
  for await (const piece of pieces) {
    buffer += piece;
    let match;
    while ((match = /\n[ \t]*\n/.exec(buffer))) {
      const paragraph = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield* splitTextForTts(paragraph, MAX_PARAGRAPH_CHARS);
    }
  }
  yield* splitTextForTts(buffer, MAX_PARAGRAPH_CHARS);
}

/**
 * Remove v3 audio tags such as "[warm] " from narration text. Used for the
 * ElevenLabs models that would read them aloud, and for Gemini TTS.
 * @param {string} text
 */
export function stripAudioTags(text) {
  return String(text ?? "")
    .replace(/\[[a-z][a-z -]{0,24}\]\s*/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Drop a leading ID3v2 tag. Every ElevenLabs MP3 carries one, and a tag in
 * the middle of a joined stream makes decoders report a missing header.
 * @param {Buffer} audio
 */
export function stripId3(audio) {
  if (audio.length < 10 || audio.toString("latin1", 0, 3) !== "ID3") return audio;
  let size = 0;
  for (const byte of audio.subarray(6, 10)) size = (size << 7) | (byte & 0x7f);
  const footer = audio[5] & 0x10 ? 10 : 0;
  return audio.subarray(10 + size + footer);
}

/**
 * Speak text with ElevenLabs. Returns MP3 audio without its ID3 tag.
 * @param {string} text
 * @param {{ apiKey: string, fetch?: typeof fetch, voice?: string, model?: string }} options
 * @returns {Promise<{ audio: Buffer, mime: string, ext: string }>}
 */
export async function synthesizeElevenLabs(text, options) {
  const fetchImpl = options.fetch || fetch;
  const voice = options.voice || DEFAULT_ELEVENLABS_VOICE;
  const model = options.model || DEFAULT_ELEVENLABS_MODEL;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: { "xi-api-key": options.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      text: supportsAudioTags(model) ? text : stripAudioTags(text),
      model_id: model,
      voice_settings: ELEVENLABS_VOICE_SETTINGS,
    }),
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs synthesis failed: ${await describeHttpError(response)}`);
  }
  const audio = stripId3(Buffer.from(await response.arrayBuffer()));
  if (!audio.length) throw new Error("ElevenLabs returned no audio");
  return { audio, mime: "audio/mpeg", ext: "mp3" };
}

/**
 * Speak text with Gemini TTS on Vertex AI. Returns raw 16-bit 24 kHz PCM.
 * @param {string} text
 * @param {{ token: string, project: string, fetch?: typeof fetch, voice?: string }} options
 * @returns {Promise<Buffer>}
 */
export async function synthesizeGeminiTtsPcm(text, options) {
  const fetchImpl = options.fetch || fetch;
  const voice = options.voice || DEFAULT_GEMINI_VOICE;
  const pcmParts = [];
  for (const chunk of splitTextForTts(text, GEMINI_TTS_CHUNK_CHARS)) {
    const response = await vertexGenerateContent(fetchImpl, options.token, options.project, GEMINI_TTS_MODEL, {
      contents: [{ role: "user", parts: [{ text: chunk }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    });
    for (const part of response?.candidates?.[0]?.content?.parts || []) {
      const data = part.inlineData?.data;
      if (data) pcmParts.push(Buffer.from(data, "base64"));
    }
  }
  const pcm = Buffer.concat(pcmParts);
  if (!pcm.length) throw new Error("Gemini TTS returned no audio");
  return pcm;
}

/**
 * Speak text with Gemini TTS on Vertex AI. Returns one WAV file.
 * @param {string} text
 * @param {{ token: string, project: string, fetch?: typeof fetch, voice?: string }} options
 * @returns {Promise<{ audio: Buffer, mime: string, ext: string }>}
 */
export async function synthesizeGeminiTts(text, options) {
  const pcm = await synthesizeGeminiTtsPcm(text, options);
  return { audio: wavFromPcm(pcm, { sampleRate: GEMINI_TTS_SAMPLE_RATE }), mime: "audio/wav", ext: "wav" };
}

/**
 * Split text into chunks below `max` characters, preferring paragraph breaks
 * and falling back to sentence ends, so each chunk stands alone as speech input.
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
export function splitTextForTts(text, max) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= max) return trimmed ? [trimmed] : [];
  const chunks = [];
  let rest = trimmed;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.3) cut = window.lastIndexOf(". ");
    if (cut < max * 0.3) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Wrap raw 16-bit mono little-endian PCM in a RIFF WAV container.
 * @param {Buffer} pcm
 * @param {{ sampleRate: number, channels?: number }} options
 */
export function wavFromPcm(pcm, options) {
  const channels = options.channels || 1;
  const sampleRate = options.sampleRate;
  const byteRate = sampleRate * channels * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Cache identity for one rendering of one block: content plus every knob
 * that changes the audio.
 * @param {string} html
 * @param {string} engine
 * @param {string} voice
 * @param {{ kind?: string, context?: string, narration?: string, model?: string }} [options]
 */
export function ttsCacheHash(html, engine, voice, options = {}) {
  return createHash("sha256")
    .update(
      `v${NARRATION_PROMPT_VERSION}\n${engine}\n${voice}\n${options.model || ""}\n${options.kind || "text"}\n${options.context || ""}\n${options.narration || ""}\n${html}`,
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * One rendering in progress. Audio pieces arrive through `chunk` events,
 * `end` marks the finished file, `failed` carries the error. `ready`
 * resolves at the first piece (or at the end), which is when the output
 * format is final and a listener can start.
 */
export class ReadAloudJob extends EventEmitter {
  /**
   * @param {{ hash: string, engine: "elevenlabs" | "gemini", voice: string }} init
   */
  constructor(init) {
    super();
    this.setMaxListeners(200);
    this.hash = init.hash;
    this.engine = init.engine;
    this.voice = init.voice;
    this.mime = init.engine === "elevenlabs" ? "audio/mpeg" : "audio/wav";
    this.ext = init.engine === "elevenlabs" ? "mp3" : "wav";
    /** @type {"running" | "done" | "error"} */
    this.state = "running";
    /** @type {Buffer[]} */
    this.chunks = [];
    this.bytes = 0;
    this.chars = 0;
    this.paragraphs = 0;
    this.narration = "";
    /** @type {string | null} */
    this.error = null;
    /** @type {string | null} */
    this.fallback = null;
    /** @type {string | null} */
    this.file = null;
    this.startedAt = Date.now();
    /** @type {() => void} */
    this._resolveReady = () => {};
    /** @type {Promise<void>} */
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    this.emit("chunk", chunk);
    this._resolveReady();
  }

  /** @param {string} file */
  finish(file) {
    this.state = "done";
    this.file = file;
    this.chunks = [];
    this._resolveReady();
    this.emit("end");
  }

  /** @param {Error} error */
  fail(error) {
    this.state = "error";
    this.error = error.message;
    this._resolveReady();
    this.emit("failed", error);
  }

  status() {
    return {
      state: this.state,
      engine: this.engine,
      voice: this.voice,
      mime: this.mime,
      chars: this.chars,
      paragraphs: this.paragraphs,
      bytes: this.bytes,
      seconds: Math.round((Date.now() - this.startedAt) / 1000),
      ...(this.error ? { error: this.error } : {}),
      ...(this.fallback ? { fallback: this.fallback } : {}),
    };
  }
}

const runningJobs = new Map();
const tokenCache = new Map();

/**
 * @typedef {object} ReadAloudOptions
 * @property {string} cacheDir The session's cache directory; one file pair per block rendering.
 * @property {string} [kind] Block kind: text, table, diagram, code, or image.
 * @property {string} [context] The heading before the block, for table and diagram intros.
 * @property {string} [narration] A fixed narration that replaces the model, used for images.
 * @property {NodeJS.ProcessEnv} [env]
 * @property {typeof fetch} [fetch]
 * @property {string} [home]
 * @property {(p: string) => boolean} [exists]
 * @property {Map<string, { token: string, expiresAt: number }>} [tokens]
 * @property {Map<string, ReadAloudJob>} [jobs]
 */

/**
 * Where one block's rendering lives and how it is keyed.
 * @param {string} html
 * @param {ReadAloudOptions} options
 */
export function describeRendering(html, options) {
  const env = options.env || process.env;
  const engine = chooseEngine(env);
  const voice =
    engine === "elevenlabs"
      ? env.LAVISH_AXI_TTS_ELEVENLABS_VOICE || DEFAULT_ELEVENLABS_VOICE
      : env.LAVISH_AXI_TTS_GEMINI_VOICE || DEFAULT_GEMINI_VOICE;
  const model = engine === "elevenlabs" ? env.LAVISH_AXI_TTS_ELEVENLABS_MODEL || DEFAULT_ELEVENLABS_MODEL : "";
  const hash = ttsCacheHash(html, engine, voice, { ...options, model });
  return { env, engine, voice, hash, base: path.join(options.cacheDir, hash) };
}

/**
 * Open the spoken rendering of one block: the cached file when the content
 * hash matches, the running job when one is in flight, or a new job.
 * Configuration problems throw at once; provider failures end the job.
 * @param {string} html Raw block HTML.
 * @param {ReadAloudOptions} options
 * @returns {Promise<{ kind: "file", file: string, mime: string, hash: string, engine: string, voice: string, chars: number } | { kind: "job", job: ReadAloudJob }>}
 */
export async function openReadAloud(html, options) {
  const { env, engine, voice, hash, base } = describeRendering(html, options);
  const cachedMeta = await readFile(`${base}.json`, "utf8").then(JSON.parse, () => null);
  if (cachedMeta?.mime) {
    return {
      kind: "file",
      file: `${base}.${cachedMeta.ext}`,
      mime: cachedMeta.mime,
      hash,
      engine: cachedMeta.engine,
      voice: cachedMeta.voice,
      chars: cachedMeta.chars,
    };
  }
  const jobs = options.jobs || runningJobs;
  const running = jobs.get(base);
  if (running) return { kind: "job", job: running };

  const keyFile = options.narration
    ? resolveGoogleKeyFile(env, { home: options.home, exists: options.exists })
    : resolveGoogleKeyFile(env, { home: options.home, exists: options.exists });
  if (!keyFile && (!options.narration || engine === "gemini")) {
    throw new ReadAloudConfigError(
      "read-aloud needs GOOGLE_APPLICATION_CREDENTIALS to point at a service-account key file for narration",
    );
  }
  const job = new ReadAloudJob({ hash, engine, voice });
  jobs.set(base, job);
  runJob(job, html, { ...options, env, base, keyFile: keyFile || "" }).finally(() => {
    if (jobs.get(base) === job) jobs.delete(base);
  });
  return { kind: "job", job };
}

/**
 * Report the rendering state for the page: cached, running, or nothing yet.
 * @param {string} html
 * @param {ReadAloudOptions} options
 */
export async function readAloudStatus(html, options) {
  const { engine, voice, hash, base } = describeRendering(html, options);
  const job = (options.jobs || runningJobs).get(base);
  if (job) return job.status();
  const cachedMeta = await readFile(`${base}.json`, "utf8").then(JSON.parse, () => null);
  if (cachedMeta?.mime) {
    return {
      state: "done",
      cached: true,
      engine: cachedMeta.engine,
      voice: cachedMeta.voice,
      mime: cachedMeta.mime,
      chars: cachedMeta.chars,
    };
  }
  return { state: "idle", engine, voice, hash };
}

/**
 * Remove renderings of blocks the page no longer has. Files of running jobs stay.
 * @param {string} cacheDir
 * @param {Iterable<string>} keepHashes
 * @param {{ jobs?: Map<string, ReadAloudJob> }} [options]
 * @returns {Promise<number>} How many files were removed.
 */
export async function pruneRenderings(cacheDir, keepHashes, options = {}) {
  const keep = new Set(keepHashes);
  for (const base of (options.jobs || runningJobs).keys()) {
    if (path.dirname(base) === cacheDir) keep.add(path.basename(base));
  }
  const entries = await readdir(cacheDir).catch(() => []);
  const stale = entries.filter((name) => !keep.has(name.split(".")[0]));
  await Promise.all(stale.map((name) => rm(path.join(cacheDir, name), { force: true })));
  return stale.length;
}

async function* fixedNarration(text) {
  yield text;
}

/**
 * @param {ReadAloudJob} job
 * @param {string} html
 * @param {ReadAloudOptions & { env: NodeJS.ProcessEnv, base: string, keyFile: string }} options
 */
async function runJob(job, html, options) {
  const { env, base } = options;
  try {
    let google = null;
    if (options.keyFile) {
      const key = JSON.parse(await readFile(options.keyFile, "utf8"));
      const tokens = options.tokens || tokenCache;
      let entry = tokens.get(options.keyFile);
      if (!entry || entry.expiresAt <= Date.now()) {
        entry = await mintGoogleAccessToken(key, { fetch: options.fetch });
        tokens.set(options.keyFile, entry);
      }
      google = { token: entry.token, project: String(key.project_id || ""), fetch: options.fetch };
    }
    await mkdir(options.cacheDir, { recursive: true });

    const elevenModel = env.LAVISH_AXI_TTS_ELEVENLABS_MODEL || DEFAULT_ELEVENLABS_MODEL;
    const audioTags = job.engine === "elevenlabs" && supportsAudioTags(elevenModel);
    const pieces = options.narration
      ? fixedNarration(options.narration)
      : streamNarration(html, { ...google, kind: options.kind, context: options.context, audioTags });
    const pcm = [];
    for await (const paragraph of paragraphsFrom(pieces)) {
      job.narration += (job.narration ? "\n\n" : "") + paragraph;
      job.chars = job.narration.length;
      if (job.engine === "elevenlabs") {
        try {
          const { audio } = await synthesizeElevenLabs(paragraph, {
            apiKey: String(env.ELEVENLABS_API_KEY || ""),
            voice: job.voice,
            model: env.LAVISH_AXI_TTS_ELEVENLABS_MODEL,
            fetch: options.fetch,
          });
          job.push(audio);
        } catch (error) {
          // A dead key or an empty balance degrades to the service-account
          // voice while nothing has been sent; a mid-stream failure cannot
          // change format and ends the job.
          if (job.bytes > 0 || !google) throw error;
          job.fallback = error instanceof Error ? error.message : String(error);
          job.engine = "gemini";
          job.voice = DEFAULT_GEMINI_VOICE;
          job.mime = "audio/wav";
          job.ext = "wav";
          pcm.push(await synthesizeGeminiTtsPcm(stripAudioTags(paragraph), { ...google, voice: job.voice }));
        }
      } else {
        pcm.push(await synthesizeGeminiTtsPcm(stripAudioTags(paragraph), { ...google, voice: job.voice }));
      }
      job.paragraphs += 1;
    }
    if (job.engine === "gemini") {
      job.push(wavFromPcm(Buffer.concat(pcm), { sampleRate: GEMINI_TTS_SAMPLE_RATE }));
    }
    if (!job.bytes) throw new Error("narration produced no audio");

    const file = `${base}.${job.ext}`;
    await writeFile(`${file}.part`, Buffer.concat(job.chunks));
    await rename(`${file}.part`, file);
    await writeFile(
      `${base}.json`,
      `${JSON.stringify(
        {
          engine: job.engine,
          voice: job.voice,
          mime: job.mime,
          ext: job.ext,
          chars: job.chars,
          narration: job.narration,
          ...(job.fallback ? { fallback: job.fallback } : {}),
        },
        null,
        2,
      )}\n`,
    );
    job.finish(file);
  } catch (error) {
    job.fail(error instanceof Error ? error : new Error(String(error)));
  }
}

function vertexModelUrl(project, model) {
  return `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${model}`;
}

async function vertexGenerateContent(fetchImpl, token, project, model, body) {
  const response = await fetchWithTimeout(fetchImpl, `${vertexModelUrl(project, model)}:generateContent`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response, `Vertex ${model}`);
}

async function fetchWithTimeout(fetchImpl, url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`request to ${new URL(url).host} timed out`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed: ${await describeHttpError(response)}`);
  }
  return response.json();
}

async function describeHttpError(response) {
  const text = await response.text().catch(() => "");
  let detail;
  try {
    const data = JSON.parse(text);
    detail = String(data?.error?.message || data?.detail?.message || data?.detail || data?.message || "");
  } catch {
    detail = text.slice(0, 200);
  }
  return detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`;
}
