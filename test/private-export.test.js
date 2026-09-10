import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPrivateExportHtml, sanitizeExportText, stripMediaMetadata } from "../src/private-export.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "private-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("private export embeds sanitized downloads and leaves the source intact", async (t) => {
  const root = await fixture(t);
  const request = {
    prompt: "Off the Line on Seedance via fal",
    seed: 95075118,
    duration: "25",
    image_urls: ["https://v3b.fal.media/private.png"],
    api_key: "secret-example",
    request_id: "01a08afd-1f9b-7fd3-a733-018e16b0923d",
  };
  await writeFile(path.join(root, "request.json"), JSON.stringify(request));
  const source = `<meta name="lavish-export-redact" content='["Off the Line"]'><h1>Seedance on fal</h1><p>owner@example.com /home/dev/private</p><div data-export-private>PRIVATE NOTES</div><a href="request.json" download>Request</a>`;
  const { html } = await buildPrivateExportHtml(source, { baseDir: root, confineDir: root });
  assert.doesNotMatch(html, /Seedance|fal\.media|Off the Line|owner@example|\/home\/dev|PRIVATE NOTES|01a08afd/);
  assert.match(html, /data:application\/json;base64,/);
  const json = JSON.parse(Buffer.from(html.match(/data:application\/json;base64,([^"\s]+)/)[1], "base64").toString());
  assert.equal(json.seed, 95075118);
  assert.equal(json.duration, "25");
  assert.equal(json.api_key, "[redacted]");
  assert.equal(json.request_id, "[redacted]");
  assert.doesNotMatch(JSON.stringify(json), /secret-example|fal|Seedance|Off the Line/);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "request.json"), "utf8")), request);
  assert.match(html, /sanitized/i);
});

test("private export blocks external dependencies without fetching them", async () => {
  const { html, warnings } = await buildPrivateExportHtml(
    '<script src="https://example.com/tracker.js"></script><img src="https://example.com/pic.png"><a href="https://example.com/account">Account</a><script>const total = 2 + 3;</script>',
  );
  assert.doesNotMatch(html, /https:\/\/example.com|tracker.js/);
  assert.match(html, /const total = 2 \+ 3/);
  assert.ok(warnings.some((w) => w.kind === "privacy-removed-resource"));
});

test("private export removes compact job IDs from text and JSON downloads", async (t) => {
  const root = await fixture(t);
  const jobId = "307fa0d0cfca43769827d20a10a29245";
  const job = { job_id: jobId, status: "running", seed: 95075118, duration: 25 };
  await writeFile(path.join(root, "job.json"), JSON.stringify(job));
  const source = `<p>App job: ${jobId}</p><a href="job.json" download>Job</a>`;
  const { html } = await buildPrivateExportHtml(source, { baseDir: root, confineDir: root });
  assert.ok(!html.includes(jobId));
  const decoded = JSON.parse(
    Buffer.from(html.match(/data:application\/json;base64,([^"\s]+)/)[1], "base64").toString(),
  );
  assert.deepEqual(decoded, { ...job, job_id: "[redacted]" });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "job.json"), "utf8")), job);
});

test("private export sanitizes JSON data URIs and embedded text", async () => {
  const payload = Buffer.from(
    JSON.stringify({
      authorization: "Bearer secret",
      owner: "person@example.com",
      model: "openai/gpt-image-2.5",
      duration: 25,
    }),
  ).toString("base64");
  const { html } = await buildPrivateExportHtml(
    `<script type="application/json">{"account_id":"account-secret","seed":7}</script><a href="data:application/json;base64,${payload}" download="fal-account.json">Data</a><!-- secret note -->`,
  );
  assert.doesNotMatch(html, /account-secret|secret note|fal-account/);
  const decoded = Buffer.from(html.match(/data:application\/json;base64,([^"\s]+)/)[1], "base64").toString();
  assert.doesNotMatch(decoded, /Bearer secret|person@example|openai|gpt-image/);
  assert.match(decoded, /25/);
});

test("private export preserves confinement for downloadable files and export alternatives", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(path.join(outside, "secret.txt"), "OUTSIDE SECRET");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  const { html } = await buildPrivateExportHtml(
    '<a href="link.txt" download>File</a><img src="safe.png" data-export-src="../secret.txt">',
    { baseDir: root, confineDir: root },
  );
  assert.doesNotMatch(html, /OUTSIDE SECRET|link.txt|secret.txt/);
});

test("redaction handles credentials, escaped URLs, UUIDs, paths, and configured names", () => {
  const text =
    "Authorization: Key a-private-key\nFAL_KEY=private-value\nhttps:\\/\\/v3b.fal.media\\/file.png\n01a08afd-1f9b-7fd3-a733-018e16b0923d\n/home/dev/project\nOff the Line";
  const clean = sanitizeExportText(text, ["Off the Line"]);
  assert.doesNotMatch(clean, /a-private-key|private-value|fal.media|01a08afd|\/home\/dev|Off the Line/);
  assert.equal(sanitizeExportText("first_attempt_not_submitted_to_seedance"), "first_attempt_not_submitted_to_service");
});

test("PNG privacy cleanup removes provenance chunks without changing image data", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, bytes) => {
    const b = Buffer.alloc(bytes.length + 12);
    b.writeUInt32BE(bytes.length);
    b.write(type, 4);
    bytes.copy(b, 8);
    return b;
  };
  const ihdr = chunk("IHDR", Buffer.alloc(13));
  const idat = chunk("IDAT", Buffer.from([1, 2, 3]));
  const dirty = Buffer.concat([
    signature,
    ihdr,
    chunk("caBX", Buffer.from("OpenAI account-secret")),
    idat,
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const clean = stripMediaMetadata(dirty, "image/png");
  assert.doesNotMatch(clean.toString(), /OpenAI|account-secret|caBX/);
  assert.ok(clean.includes(idat));
});
