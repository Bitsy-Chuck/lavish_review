// Hosted sharing transport: publish a self-contained HTML page to ht-ml.app
// (https://ht-ml.app), a third-party hosting service not part of Lavish, and return a visitable
// share URL. Creation needs no account or API key - `POST /v1/sites` sends the HTML to
// ht-ml.app's servers with an optional password, then returns a `url` plus a secret
// `update_key` (the only credential, returned once, used later to update or delete the page).
// Shares are public by default; when a password is supplied, viewers must enter it before viewing.
// An optional bearer token is supported for callers who have one but is never required.
//
// ht-ml.app runs on AWS Lambda behind API Gateway, which rejects any request of 6 MiB or more
// (measured 2026-09-10: `413 Request must be smaller than 6291456 bytes`), and it stores each
// uploaded asset only up to 4.5 MB (`413 Asset too large: max 4500000 bytes`). A Lavish artifact
// with screenshots or video inlined as data URIs blows through the page cap, so
// `shareArtifactToHtmlApp` inlines local assets only within a budget that keeps the page under
// the cap and uploads the rest as separate site files through `POST /v1/sites/{id}/assets`.
// ht-ml.app accepts an upload only for a file the page references by a plain relative `src` or
// `href` (not `./x`, `poster`, `<track>`, or CSS `url()`), so a refused upload is reported as an
// unresolved local asset instead of failing the publish.

import { stat } from "node:fs/promises";
import path from "node:path";

import { buildSelfContainedHtml, readConfinedFile } from "./export-bundle.js";

const DEFAULT_API_URL = "https://api.ht-ml.app";
const PUBLISH_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 60_000;

// Largest request body ht-ml.app accepts, in bytes: the request must stay below this.
export const HTML_APP_MAX_REQUEST_BYTES = 6_291_456;
// Largest single asset ht-ml.app stores, in bytes.
export const HTML_APP_MAX_ASSET_BYTES = 4_500_000;
// Room kept for the JSON envelope, the password, and the injected base layer when computing how
// many local asset bytes the page can inline. JSON escaping of the page text itself (quotes,
// backslashes, newlines) is covered by budgeting the source at 125 percent of its size.
const SHARE_ENVELOPE_BYTES = 64 * 1024;
const SHARE_SOURCE_GROWTH = 1.25;

export function htmlAppApiUrl(env = process.env) {
  return String(env.LAVISH_AXI_HTML_APP_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

export function createHtmlAppPayload(html, options = {}) {
  const body = { html_content: String(html ?? "") };
  const password = optionalString(options.password);
  if (password) body.password = password;
  return body;
}

/**
 * How many local asset bytes a share may inline so the published page stays under ht-ml.app's
 * request cap. Inlined binary assets grow by 4/3 as base64 data URIs; text assets grow less,
 * so the budget errs on the safe side for them. The page text is counted at 125 percent of its
 * size because JSON escaping grows it.
 * @param {number} sourceBytes Size of the artifact HTML before inlining.
 * @param {number} [maxRequestBytes]
 */
export function shareInlineBudget(sourceBytes, maxRequestBytes = HTML_APP_MAX_REQUEST_BYTES) {
  const reserved = SHARE_ENVELOPE_BYTES + Math.ceil(sourceBytes * SHARE_SOURCE_GROWTH);
  return Math.floor(((maxRequestBytes - reserved) * 3) / 4);
}

/**
 * Publish HTML to the third-party ht-ml.app service and return the live site.
 * @param {string} html The (ideally self-contained) HTML to send to the host.
 * @param {object} [options]
 * @param {string} [options.password] Make the site private behind this password.
 * @param {string} [options.token] Optional bearer token (never required to create a site).
 * @param {string} [options.apiUrl] Override the API base (defaults to LAVISH_AXI_HTML_APP_API_URL or ht-ml.app).
 * @param {typeof fetch} [options.fetch] Injected fetch for testing.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxRequestBytes] Request cap to enforce before sending (tests only).
 * @returns {Promise<{ url: string, site_id: string, update_key: string, status: string }>}
 */
export async function publishToHtmlApp(html, options = {}) {
  const env = options.env || process.env;
  const apiUrl = resolveApiUrl(options, env);
  const fetchImpl = options.fetch || fetch;
  const token = optionalString(options.token ?? env.LAVISH_AXI_HTML_APP_TOKEN);
  const maxRequestBytes = options.maxRequestBytes || HTML_APP_MAX_REQUEST_BYTES;

  const body = JSON.stringify(createHtmlAppPayload(html, options));
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes >= maxRequestBytes) {
    throw Object.assign(new Error(`ht-ml.app publish failed: ${pageTooLargeText(bodyBytes, maxRequestBytes)}`), {
      code: "TOO_LARGE",
    });
  }

  const headers = { "content-type": "application/json", "user-agent": "lavish-axi" };
  if (token) headers.authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || PUBLISH_TIMEOUT_MS);
  let response;
  let text;
  try {
    response = await fetchImpl(`${apiUrl}/v1/sites`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("ht-ml.app publish timed out", { cause: error });
    }
    throw new Error(`ht-ml.app publish failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = text ? parseJson(text) : {};
  if (!response.ok) {
    if (response.status === 413) {
      throw Object.assign(new Error(`ht-ml.app publish failed: ${pageTooLargeText(bodyBytes, maxRequestBytes)}`), {
        code: "TOO_LARGE",
      });
    }
    throw new Error(`ht-ml.app publish failed: ${describeError(response.status, data, text)}`);
  }

  const url = optionalString(data.url);
  if (!url) {
    throw new Error("ht-ml.app publish failed: response did not include a url");
  }
  const updateKey = optionalString(data.update_key);
  if (!updateKey) {
    throw new Error("ht-ml.app publish failed: response did not include an update_key");
  }
  return {
    url,
    site_id: String(data.site_id || ""),
    update_key: updateKey,
    status: String(data.status || ""),
  };
}

/**
 * Upload one local file as a separate asset of a published ht-ml.app site. The page must
 * reference the file by the same site-relative path, or ht-ml.app refuses the upload.
 * @param {object} options
 * @param {string} options.siteId
 * @param {string} options.updateKey The site's secret update_key (the only accepted credential).
 * @param {string} options.relativePath Site-relative path, such as `media/clip.mp4`.
 * @param {Uint8Array} options.bytes File content.
 * @param {string} [options.apiUrl]
 * @param {typeof fetch} [options.fetch]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxAssetBytes] Asset cap to enforce before sending (tests only).
 * @returns {Promise<{ relative_path: string }>}
 */
export async function uploadHtmlAppAsset(options) {
  const env = options.env || process.env;
  const apiUrl = resolveApiUrl(options, env);
  const fetchImpl = options.fetch || fetch;
  const relativePath = optionalString(options.relativePath);
  const maxAssetBytes = options.maxAssetBytes || HTML_APP_MAX_ASSET_BYTES;
  if (!relativePath) throw new Error("ht-ml.app upload failed: a site-relative path is required");
  const bytes = options.bytes;
  if (bytes.length > maxAssetBytes) {
    throw Object.assign(new Error(assetTooLargeText(relativePath, bytes.length, maxAssetBytes)), {
      code: "TOO_LARGE",
    });
  }

  const form = new FormData();
  form.append("file", new Blob([/** @type {BlobPart} */ (bytes)]), path.posix.basename(relativePath));
  const url =
    `${apiUrl}/v1/sites/${encodeURIComponent(options.siteId)}/assets` +
    `?relative_path=${relativePath.split("/").map(encodeURIComponent).join("/")}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || UPLOAD_TIMEOUT_MS);
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${options.updateKey}`, "user-agent": "lavish-axi" },
      body: form,
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`ht-ml.app upload of ${relativePath} timed out`, { cause: error });
    }
    throw new Error(
      `ht-ml.app upload of ${relativePath} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const data = text ? parseJson(text) : {};
    if (response.status === 413) {
      throw Object.assign(new Error(assetTooLargeText(relativePath, bytes.length, maxAssetBytes)), {
        code: "TOO_LARGE",
      });
    }
    const detail = describeError(response.status, data, text);
    const hint =
      response.status === 403
        ? " - ht-ml.app accepts an upload only for a file the page references by a plain relative src or href"
        : "";
    throw new Error(`ht-ml.app refused the upload of ${relativePath}: ${detail}${hint}`);
  }
  return { relative_path: relativePath };
}

/**
 * Publish a Lavish artifact on ht-ml.app: inline local assets within the page budget, create
 * the site, then upload every local file the budget left as a reference as a separate site
 * asset. A file that ht-ml.app cannot host is reported as an unresolved local asset.
 * @param {string} source The artifact HTML as written on disk.
 * @param {object} options
 * @param {string} options.baseDir Directory the artifact's relative references resolve from.
 * @param {string} [options.confineDir] Directory local reads are confined to (defaults to baseDir).
 * @param {(refPath: string) => string | null} [options.resolveAbsolute] Trusted root-absolute resolver (design assets).
 * @param {string} [options.password]
 * @param {string} [options.token]
 * @param {string} [options.apiUrl]
 * @param {typeof fetch} [options.fetch]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(absPath: string) => Promise<Uint8Array>} [options.readLocalFile] Confined read used for uploads.
 * @param {number} [options.maxRequestBytes] Request cap (tests only).
 * @param {number} [options.maxAssetBytes] Asset cap (tests only).
 * @returns {Promise<{ site: { url: string, site_id: string, update_key: string, status: string }, html: string, warnings: Array<{ kind: string, ref: string, reason?: string }>, uploaded: string[] }>}
 */
export async function shareArtifactToHtmlApp(source, options) {
  const root = path.resolve(options.confineDir || options.baseDir);
  const maxRequestBytes = options.maxRequestBytes || HTML_APP_MAX_REQUEST_BYTES;
  const maxAssetBytes = options.maxAssetBytes || HTML_APP_MAX_ASSET_BYTES;
  const html = String(source ?? "");
  const sourceBytes = Buffer.byteLength(html);
  const inlineBudget = shareInlineBudget(sourceBytes, maxRequestBytes);
  if (inlineBudget <= 0) {
    throw Object.assign(
      new Error(
        `ht-ml.app publish failed: the page is ${formatMegabytes(sourceBytes)} MB before any local asset is inlined, ` +
          `but ht-ml.app accepts at most ${formatMegabytes(maxRequestBytes)} MB per page`,
      ),
      { code: "TOO_LARGE" },
    );
  }
  const readLocalFile = options.readLocalFile || ((absPath) => readConfinedFile(absPath, root));

  const built = await buildSelfContainedHtml(html, {
    baseDir: options.baseDir,
    confineDir: root,
    resolveAbsolute: options.resolveAbsolute,
    maxBundleBytes: inlineBudget,
  });
  const site = await publishToHtmlApp(built.html, {
    password: options.password,
    token: options.token,
    apiUrl: options.apiUrl,
    fetch: options.fetch,
    env: options.env,
    maxRequestBytes,
  });

  const uploaded = [];
  const warnings = [];
  const seen = new Set();
  for (const warning of built.warnings) {
    if (warning.kind !== "too-large" || !warning.path) {
      warnings.push(warning);
      continue;
    }
    const relativePath = siteRelativePath(root, warning.path);
    if (!relativePath) {
      warnings.push(warning);
      continue;
    }
    // The same file referenced twice is delivered once.
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    const failure = await uploadLocalAsset({
      absPath: warning.path,
      relativePath,
      ref: warning.ref,
      site,
      readLocalFile,
      maxAssetBytes,
      apiUrl: options.apiUrl,
      fetch: options.fetch,
      env: options.env,
    });
    if (failure) warnings.push(failure);
    else uploaded.push(relativePath);
  }
  return { site, html: built.html, warnings, uploaded };
}

// Upload one file the bundle left as a reference; returns a warning on failure, else null.
async function uploadLocalAsset({
  absPath,
  relativePath,
  ref,
  site,
  readLocalFile,
  maxAssetBytes,
  apiUrl,
  fetch,
  env,
}) {
  let size;
  try {
    size = (await stat(absPath)).size;
  } catch (error) {
    return { kind: "load-failed", ref, reason: error instanceof Error ? error.message : String(error) };
  }
  if (size > maxAssetBytes) {
    return { kind: "too-large", ref, reason: assetTooLargeText(relativePath, size, maxAssetBytes) };
  }
  let bytes;
  try {
    bytes = await readLocalFile(absPath);
  } catch (error) {
    const outside = error && typeof error === "object" && "code" in error && error.code === "OUTSIDE_ROOT";
    return {
      kind: outside ? "outside-root" : "load-failed",
      ref,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    await uploadHtmlAppAsset({
      siteId: site.site_id,
      updateKey: site.update_key,
      relativePath,
      bytes,
      maxAssetBytes,
      apiUrl,
      fetch,
      env,
    });
  } catch (error) {
    const tooLarge = error && typeof error === "object" && "code" in error && error.code === "TOO_LARGE";
    return {
      kind: tooLarge ? "too-large" : "upload-failed",
      ref,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return null;
}

// The path ht-ml.app serves the file at, relative to the site root, or null when the file lives
// outside the artifact directory and no site-relative reference can reach it.
function siteRelativePath(root, absPath) {
  const relative = path.relative(root, absPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function pageTooLargeText(bytes, maxRequestBytes) {
  return (
    `the page is ${formatMegabytes(bytes)} MB with its local assets inlined, ` +
    `but ht-ml.app accepts at most ${formatMegabytes(maxRequestBytes)} MB per page`
  );
}

function assetTooLargeText(relativePath, bytes, maxAssetBytes) {
  return (
    `${relativePath} is ${formatMegabytes(bytes)} MB, ` +
    `but ht-ml.app accepts separate assets only up to ${formatMegabytes(maxAssetBytes)} MB`
  );
}

export function formatMegabytes(bytes) {
  return (Number(bytes) / 1_000_000).toFixed(1);
}

function resolveApiUrl(options, env) {
  return (options.apiUrl ? String(options.apiUrl).replace(/\/+$/, "") : "") || htmlAppApiUrl(env);
}

function describeError(status, data, text) {
  const detail = optionalString(data.detail || data.error || data.message || data.Message);
  if (detail) return detail;
  if (status === 422) return "the HTML failed ht-ml.app's content safety scan";
  if (status === 401) return "unauthorized (invalid update_key, or the site is password protected)";
  if (status === 403) return "forbidden";
  return text ? text.slice(0, 200) : `HTTP ${status}`;
}

function optionalString(value) {
  return String(value ?? "").trim();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}
