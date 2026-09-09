import assert from "node:assert/strict";
import test from "node:test";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHtmlAppPayload,
  HTML_APP_MAX_REQUEST_BYTES,
  htmlAppApiUrl,
  publishToHtmlApp,
  shareArtifactToHtmlApp,
  shareInlineBudget,
  uploadHtmlAppAsset,
} from "../src/html-app.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetchImpl, calls };
}

test("createHtmlAppPayload sends html_content and only adds a password when provided", () => {
  assert.deepEqual(createHtmlAppPayload("<h1>Hi</h1>"), { html_content: "<h1>Hi</h1>" });
  assert.deepEqual(createHtmlAppPayload("<h1>Hi</h1>", { password: "  secret " }), {
    html_content: "<h1>Hi</h1>",
    password: "secret",
  });
  assert.deepEqual(createHtmlAppPayload("<h1>Hi</h1>", { password: "   " }), { html_content: "<h1>Hi</h1>" });
});

test("htmlAppApiUrl defaults to ht-ml.app and honors the override env", () => {
  assert.equal(htmlAppApiUrl({}), "https://api.ht-ml.app");
  assert.equal(htmlAppApiUrl({ LAVISH_AXI_HTML_APP_API_URL: "http://127.0.0.1:9/" }), "http://127.0.0.1:9");
});

test("publishToHtmlApp posts the HTML to /v1/sites and returns the public url and update key", async () => {
  const { fetchImpl, calls } = recordingFetch(
    jsonResponse(200, {
      site_id: "abc123",
      url: "https://abc123.ht-ml.app/",
      update_key: "uk_secret",
      status: "active",
    }),
  );

  const result = await publishToHtmlApp("<h1>Ship me</h1>", {
    password: "hunter2",
    apiUrl: "https://api.example",
    fetch: fetchImpl,
    env: {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example/v1/sites");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), { html_content: "<h1>Ship me</h1>", password: "hunter2" });
  assert.deepEqual(result, {
    url: "https://abc123.ht-ml.app/",
    site_id: "abc123",
    update_key: "uk_secret",
    status: "active",
  });
});

test("publishToHtmlApp sends a bearer token when one is configured", async () => {
  const { fetchImpl, calls } = recordingFetch(jsonResponse(200, { url: "https://x.ht-ml.app/", update_key: "uk" }));

  await publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: { LAVISH_AXI_HTML_APP_TOKEN: "tok_123" } });

  assert.equal(calls[0].init.headers.authorization, "Bearer tok_123");
});

test("publishToHtmlApp rejects a successful response that omits the url", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(200, { site_id: "abc", update_key: "uk" }));

  await assert.rejects(
    () => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {} }),
    /response did not include a url/,
  );
});

test("publishToHtmlApp rejects a successful response that omits the update key", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(200, { site_id: "abc", url: "https://abc.ht-ml.app/" }));

  await assert.rejects(
    () => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {} }),
    /response did not include an update_key/,
  );
});

test("publishToHtmlApp explains a failed content safety scan", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(422, {}));

  await assert.rejects(
    () => publishToHtmlApp("<script>evil()</script>", { fetch: fetchImpl, env: {} }),
    /content safety scan/,
  );
});

test("publishToHtmlApp surfaces an error detail returned by the API", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(400, { detail: "html_content is required" }));

  await assert.rejects(() => publishToHtmlApp("", { fetch: fetchImpl, env: {} }), /html_content is required/);
});

test("publishToHtmlApp keeps the timeout active while reading the response body", async () => {
  let textStarted = false;
  /** @type {any} */
  const fetchImpl = async (_url, init) => ({
    ok: true,
    status: 200,
    text: async () => {
      textStarted = true;
      await new Promise((resolve, reject) => {
        const abort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init.signal.aborted) {
          abort();
          return;
        }
        init.signal.addEventListener("abort", abort, { once: true });
      });
      return "";
    },
  });

  await assert.rejects(() => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {}, timeoutMs: 1 }), /timed out/);
  assert.equal(textStarted, true);
});

test("shareInlineBudget leaves room for base64 growth and the request envelope", () => {
  // (cap - 64 KiB envelope - 125% of the source) * 3/4: inlined binaries grow by 4/3 as data URIs
  // and JSON escaping grows the page text.
  assert.equal(shareInlineBudget(0, 1_000_000 + 64 * 1024), 750_000);
  assert.equal(shareInlineBudget(400_000, 1_000_000 + 64 * 1024), 375_000);
  assert.ok(shareInlineBudget(HTML_APP_MAX_REQUEST_BYTES) < 0);
});

test("publishToHtmlApp refuses a page at or over the request cap before sending it", async () => {
  const { fetchImpl, calls } = recordingFetch(jsonResponse(200, { url: "https://x.ht-ml.app/", update_key: "uk" }));

  await assert.rejects(
    () => publishToHtmlApp("x".repeat(1_000_000), { fetch: fetchImpl, env: {}, maxRequestBytes: 1_000_000 }),
    (error) =>
      error instanceof Error &&
      /** @type {any} */ (error).code === "TOO_LARGE" &&
      /the page is 1\.0 MB with its local assets inlined, but ht-ml\.app accepts at most 1\.0 MB per page/.test(
        error.message,
      ),
  );
  assert.equal(calls.length, 0);
});

test("publishToHtmlApp explains a 413 from the host in page terms", async () => {
  const { fetchImpl } = recordingFetch(
    jsonResponse(413, { Message: "Request must be smaller than 6291456 bytes for the InvokeFunction operation" }),
  );

  await assert.rejects(
    () => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {} }),
    (error) =>
      error instanceof Error &&
      /** @type {any} */ (error).code === "TOO_LARGE" &&
      /accepts at most 6\.3 MB per page/.test(error.message),
  );
});

test("publishToHtmlApp surfaces a gateway Message detail", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(502, { Message: "Internal server error" }));

  await assert.rejects(() => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {} }), /Internal server error/);
});

test("uploadHtmlAppAsset posts the file as multipart form data with the site update key", async () => {
  const { fetchImpl, calls } = recordingFetch(jsonResponse(200, { message: "Asset uploaded successfully" }));

  const result = await uploadHtmlAppAsset({
    siteId: "abc123",
    updateKey: "uk_secret",
    relativePath: "media/sp ace.mp4",
    bytes: Buffer.from("video-bytes"),
    apiUrl: "https://api.example",
    fetch: fetchImpl,
    env: {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example/v1/sites/abc123/assets?relative_path=media/sp%20ace.mp4");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer uk_secret");
  assert.ok(calls[0].init.body instanceof FormData);
  const file = /** @type {File} */ (calls[0].init.body.get("file"));
  assert.equal(file.name, "sp ace.mp4");
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "video-bytes");
  assert.deepEqual(result, { relative_path: "media/sp ace.mp4" });
});

test("uploadHtmlAppAsset refuses an asset over the cap before sending it", async () => {
  const { fetchImpl, calls } = recordingFetch(jsonResponse(200, {}));

  await assert.rejects(
    () =>
      uploadHtmlAppAsset({
        siteId: "abc123",
        updateKey: "uk",
        relativePath: "media/big.bin",
        bytes: Buffer.alloc(1_500_000),
        maxAssetBytes: 1_000_000,
        fetch: fetchImpl,
        env: {},
      }),
    (error) =>
      error instanceof Error &&
      /** @type {any} */ (error).code === "TOO_LARGE" &&
      /media\/big\.bin is 1\.5 MB, but ht-ml\.app accepts separate assets only up to 1\.0 MB/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("uploadHtmlAppAsset explains a refused upload", async () => {
  const { fetchImpl } = recordingFetch(
    jsonResponse(403, { detail: "Failed to upload asset. Check update_key or if asset is in HTML." }),
  );

  await assert.rejects(
    () =>
      uploadHtmlAppAsset({
        siteId: "abc123",
        updateKey: "uk",
        relativePath: "media/poster.png",
        bytes: Buffer.from("png"),
        fetch: fetchImpl,
        env: {},
      }),
    /refused the upload of media\/poster\.png: Failed to upload asset.*plain relative src or href/,
  );
});

test("uploadHtmlAppAsset maps a 413 from the host to the asset cap", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(413, { detail: "Asset too large: max 4500000 bytes." }));

  await assert.rejects(
    () =>
      uploadHtmlAppAsset({
        siteId: "abc123",
        updateKey: "uk",
        relativePath: "media/clip.mp4",
        bytes: Buffer.alloc(10),
        fetch: fetchImpl,
        env: {},
      }),
    (error) =>
      error instanceof Error &&
      /** @type {any} */ (error).code === "TOO_LARGE" &&
      /accepts separate assets only up to 4\.5 MB/.test(error.message),
  );
});

function fakeHtmlAppFetch({ refuse = [] } = {}) {
  const calls = [];
  /** @type {any} */
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v1/sites")) {
      return jsonResponse(200, {
        site_id: "abc123",
        url: "https://abc123.ht-ml.app/",
        update_key: "uk_secret",
        status: "active",
      });
    }
    const refused = refuse.some((relativePath) => String(url).endsWith(`relative_path=${relativePath}`));
    if (refused) {
      return jsonResponse(403, { detail: "Failed to upload asset. Check update_key or if asset is in HTML." });
    }
    return jsonResponse(200, { message: "Asset uploaded successfully" });
  };
  return { fetchImpl, calls };
}

test("shareArtifactToHtmlApp inlines what fits, uploads the rest, and reports what ht-ml.app cannot host", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-share-"));
  try {
    await mkdir(path.join(dir, "media"));
    await writeFile(path.join(dir, "small.css"), ".btn{color:red}");
    await writeFile(path.join(dir, "media", "big.bin"), Buffer.alloc(600_000, 1));
    await writeFile(path.join(dir, "media", "huge.bin"), Buffer.alloc(2_000_000, 2));
    await writeFile(path.join(dir, "media", "poster.bin"), Buffer.alloc(600_000, 3));
    const source =
      '<!doctype html><html><head><link rel="stylesheet" href="small.css"></head><body>' +
      '<img src="media/big.bin"><img src="media/big.bin">' +
      '<video src="media/huge.bin" poster="media/poster.bin"></video></body></html>';
    const { fetchImpl, calls } = fakeHtmlAppFetch({ refuse: ["media/poster.bin"] });

    const result = await shareArtifactToHtmlApp(source, {
      baseDir: dir,
      confineDir: dir,
      password: "pw",
      fetch: fetchImpl,
      env: {},
      // Budget: (cap - 64 KiB - source) * 3/4 = about 300 KB, so the stylesheet inlines and
      // every media file stays a reference.
      maxRequestBytes: 64 * 1024 + 400_000,
      maxAssetBytes: 1_000_000,
    });

    assert.equal(result.site.url, "https://abc123.ht-ml.app/");
    assert.match(result.html, /<style>\.btn\{color:red\}<\/style>/);
    assert.match(result.html, /<img src="media\/big\.bin"><img src="media\/big\.bin">/);
    assert.match(result.html, /<video src="media\/huge\.bin" poster="media\/poster\.bin">/);
    assert.deepEqual(result.uploaded, ["media/big.bin"]);
    assert.deepEqual(
      result.warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
      [
        { kind: "too-large", ref: "media/huge.bin" },
        { kind: "upload-failed", ref: "media/poster.bin" },
      ],
    );
    assert.match(
      result.warnings[0].reason || "",
      /media\/huge\.bin is 2\.0 MB, but ht-ml\.app accepts separate assets only up to 1\.0 MB/,
    );
    assert.match(result.warnings[1].reason || "", /refused the upload of media\/poster\.bin/);
    assert.equal(
      result.warnings.some((warning) => "path" in warning),
      false,
    );

    // One publish, then one upload per distinct file the budget left out (big.bin once, not twice;
    // huge.bin never, because it is over the asset cap).
    assert.deepEqual(
      calls.map((call) => call.url.replace(/^https:\/\/api\.ht-ml\.app/, "")),
      [
        "/v1/sites",
        "/v1/sites/abc123/assets?relative_path=media/big.bin",
        "/v1/sites/abc123/assets?relative_path=media/poster.bin",
      ],
    );
    assert.equal(JSON.parse(calls[0].init.body).password, "pw");
    assert.equal(calls[1].init.headers.authorization, "Bearer uk_secret");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shareArtifactToHtmlApp fails before publishing when the page itself is over the cap", async () => {
  const { fetchImpl, calls } = fakeHtmlAppFetch();

  await assert.rejects(
    () =>
      shareArtifactToHtmlApp("<h1>" + "x".repeat(200_000) + "</h1>", {
        baseDir: tmpdir(),
        fetch: fetchImpl,
        env: {},
        maxRequestBytes: 100_000,
      }),
    (error) =>
      error instanceof Error &&
      /** @type {any} */ (error).code === "TOO_LARGE" &&
      /the page is 0\.2 MB before any local asset is inlined, but ht-ml\.app accepts at most 0\.1 MB per page/.test(
        error.message,
      ),
  );
  assert.equal(calls.length, 0);
});

test("shareArtifactToHtmlApp uploads nothing when the publish fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-share-"));
  try {
    await writeFile(path.join(dir, "big.bin"), Buffer.alloc(600_000, 1));
    const calls = [];
    /** @type {any} */
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(422, {});
    };

    await assert.rejects(
      () =>
        shareArtifactToHtmlApp('<!doctype html><html><body><img src="big.bin"></body></html>', {
          baseDir: dir,
          confineDir: dir,
          fetch: fetchImpl,
          env: {},
          maxRequestBytes: 64 * 1024 + 400_000,
        }),
      /content safety scan/,
    );
    assert.equal(calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
