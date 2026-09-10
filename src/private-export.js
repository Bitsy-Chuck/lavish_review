import path from "node:path";
import { parse, serialize, serializeOuter } from "parse5";
import { buildSelfContainedHtml, readConfinedFile } from "./export-bundle.js";

const REDACTED = "[redacted]";
const PROVIDERS =
  /\b(?:fal(?:\.ai)?|seedance(?:\s+\d+(?:\.\d+)*)?|bytedance|byteplus|openai|gpt[- ]image(?:[- ]\d+(?:\.\d+)*)?|sunburst|gemini(?:\s+\d+(?:\.\d+)*)?(?:\s+flash)?|volcengine)\b/gi;
const PRIVATE_KEY =
  /(?:^(?:authorization|cookie|set.cookie|password|passwd|secret|token|api.key|access.key|private.key|client.secret|credentials?|account(?:.id)?|request.id|end.user.id|user.id|owner|email|created.at|submitted.at)$|sha256$)/i;
const TEXT_EXTENSIONS = /\.(?:json|txt|sh|csv|md|vtt|log|yaml|yml|xml)$/i;
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

/** Remove recognizable service, credential, and identity strings from public text. */
export function sanitizeExportText(value, terms = []) {
  let text = String(value).replace(/\\\//g, "/");
  for (const term of terms) {
    if (term) text = text.replace(new RegExp(escapeRegex(term), "gi"), REDACTED);
  }
  return text
    .replace(/\bFAL_KEY\b/g, "API_KEY")
    .replace(/(?<![a-z0-9])(?:seedance|fal|openai|gemini|bytedance|byteplus)(?![a-z0-9])/gi, "service")
    .replace(/\b(?:Authorization|Proxy-Authorization)\s*:\s*[^\r\n]+/gi, "Authorization: [redacted]")
    .replace(/\b[\w-]*(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|FAL_KEY)\s*=\s*[^\s;]+/gi, "CREDENTIAL=[redacted]")
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{15,}|AKIA[A-Z0-9]{16}|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g,
      REDACTED,
    )
    .replace(/(?:https?:\/\/|file:\/\/|www\.)[^\s<>"'`\\)]+/gi, "[URL removed]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, REDACTED)
    .replace(/(?:\/(?:home|Users|private|tmp|mnt|var)\/|[A-Z]:\\Users\\)[^\s<>"'`]+/gi, "[path removed]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[address removed]")
    .replace(PROVIDERS, "service")
    .replace(/\bexact (request|response|prompt|JSON|curl)/gi, "sanitized $1");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function get(node, name) {
  return node.attrs?.find((a) => a.name === name)?.value;
}
function set(node, name, value) {
  const attr = node.attrs?.find((a) => a.name === name);
  if (attr) attr.value = value;
  else (node.attrs ||= []).push({ name, value });
}
function remove(node, name) {
  node.attrs = (node.attrs || []).filter((a) => a.name !== name);
}
function children(node) {
  return [...(node.childNodes || []), ...(node.content ? [node.content] : [])];
}
function visit(node, callback) {
  callback(node);
  for (const child of children(node)) visit(child, callback);
}
function drop(node) {
  if (node.parentNode?.childNodes) node.parentNode.childNodes = node.parentNode.childNodes.filter((n) => n !== node);
}

function sanitizeJson(value, terms) {
  if (Array.isArray(value)) return value.map((v) => sanitizeJson(v, terms));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        sanitizeExportText(key, terms),
        PRIVATE_KEY.test(key) || PRIVATE_KEY.test(sanitizeExportText(key, terms))
          ? REDACTED
          : sanitizeJson(item, terms),
      ]),
    );
  return typeof value === "string" ? sanitizeExportText(value, terms) : value;
}

function cleanTextFile(buffer, mime, terms) {
  const text = buffer.toString("utf8");
  if (mime === "application/json") {
    return Buffer.from(JSON.stringify(sanitizeJson(JSON.parse(text), terms), null, 2) + "\n");
  }
  return Buffer.from(sanitizeExportText(text, terms));
}

/** Strip non-rendering provenance and descriptive metadata from supported media. */
export function stripMediaMetadata(input, mime) {
  const buffer = Buffer.from(input);
  if (mime === "image/png") {
    if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Invalid PNG");
    const parts = [buffer.subarray(0, 8)];
    const allowed = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "acTL", "fcTL", "fdAT"]);
    let offset = 8;
    while (offset + 12 <= buffer.length) {
      const size = buffer.readUInt32BE(offset) + 12;
      if (offset + size > buffer.length) throw new Error("Invalid PNG chunk");
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      if (allowed.has(type)) parts.push(buffer.subarray(offset, offset + size));
      offset += size;
      if (type === "IEND") return Buffer.concat(parts);
    }
    throw new Error("Incomplete PNG");
  }
  if (mime === "image/jpeg") {
    if (buffer.readUInt16BE(0) !== 0xffd8) throw new Error("Invalid JPEG");
    const parts = [buffer.subarray(0, 2)];
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) throw new Error("Invalid JPEG marker");
      const marker = buffer[offset + 1];
      if (marker === 0xda || marker === 0xd9) return Buffer.concat([...parts, buffer.subarray(offset)]);
      const size = buffer.readUInt16BE(offset + 2) + 2;
      if (size < 4 || offset + size > buffer.length) throw new Error("Invalid JPEG segment");
      if (!(marker >= 0xe1 && marker <= 0xef) && marker !== 0xfe) parts.push(buffer.subarray(offset, offset + size));
      offset += size;
    }
    throw new Error("Incomplete JPEG");
  }
  if (mime === "image/webp") {
    if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP")
      throw new Error("Invalid WebP");
    const parts = [];
    for (let offset = 12; offset + 8 <= buffer.length; ) {
      const size = buffer.readUInt32LE(offset + 4);
      const end = offset + 8 + size + (size % 2);
      if (end > buffer.length) throw new Error("Invalid WebP chunk");
      const type = buffer.toString("ascii", offset, offset + 4);
      if (!["EXIF", "XMP ", "C2PA"].includes(type)) {
        const chunk = Buffer.from(buffer.subarray(offset, end));
        if (type === "VP8X") chunk[8] &= ~0x0c;
        parts.push(chunk);
      }
      offset = end;
    }
    const body = Buffer.concat(parts);
    const header = Buffer.from(buffer.subarray(0, 12));
    header.writeUInt32LE(body.length + 4, 4);
    return Buffer.concat([header, body]);
  }
  if (mime === "video/mp4" || mime === "audio/mp4") {
    const out = Buffer.from(buffer);
    scrubMp4Atoms(out, 0, out.length);
    return out;
  }
  throw new Error("Unsupported private media format");
}

function scrubMp4Atoms(buffer, start, end) {
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl", "moof", "traf"]);
  for (let offset = start; offset + 8 <= end; ) {
    const rawSize = buffer.readUInt32BE(offset);
    const size = rawSize === 1 ? Number(buffer.readBigUInt64BE(offset + 8)) : rawSize || end - offset;
    const header = rawSize === 1 ? 16 : 8;
    if (!Number.isSafeInteger(size) || size < header || offset + size > end) throw new Error("Invalid MP4 atom");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (["udta", "meta", "uuid", "free", "skip"].includes(type)) {
      buffer.write("free", offset + 4, "ascii");
      buffer.fill(0, offset + header, offset + size);
    } else if (containers.has(type)) scrubMp4Atoms(buffer, offset + header, offset + size);
    offset += size;
  }
}

function sanitizeDataUri(value, terms, cache, warnings) {
  if (cache.has(value)) return cache.get(value);
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(value);
  if (!match) return "about:blank";
  const mime = match[1].toLowerCase();
  try {
    const buffer = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
    let clean;
    if (/^(?:image\/(?:png|jpeg|webp)|video\/mp4|audio\/mp4)$/.test(mime)) clean = stripMediaMetadata(buffer, mime);
    else if (mime === "image/svg+xml") clean = Buffer.from(sanitizeDocument(buffer.toString(), terms, warnings).html);
    else if (mime === "application/json" || mime.startsWith("text/")) clean = cleanTextFile(buffer, mime, terms);
    else if (/^(?:font\/|application\/(?:font-|vnd\.ms-fontobject))/.test(mime)) clean = buffer;
    else throw new Error("Unsupported attachment format");
    const result = `data:${mime};base64,${clean.toString("base64")}`;
    cache.set(value, result);
    return result;
  } catch {
    warnings.push({
      kind: "privacy-removed-resource",
      ref: "embedded attachment",
      reason: "The attachment could not be sanitized.",
    });
    cache.set(value, "about:blank");
    return "about:blank";
  }
}

function sanitizeDocument(source, terms, warnings) {
  const cache = new Map();
  const { masked, resources, prefix, restore } = maskDataUris(source, (value) =>
    sanitizeDataUri(value, terms, cache, warnings),
  );
  // Keep large base64 payloads out of the HTML tokenizer. It allocates per character.
  const document = parse(masked);
  visit(document, (node) => {
    if (node.nodeName === "#comment") {
      drop(node);
      return;
    }
    if (node.nodeName === "#text") {
      const parent = node.parentNode;
      if (parent?.tagName === "script") {
        const type = get(parent, "type") || "";
        if (type === "application/json" || type === "application/ld+json") {
          try {
            node.value = JSON.stringify(sanitizeJson(JSON.parse(node.value), terms)).replace(/</g, "\\u003c");
          } catch {
            node.value = "{}";
          }
        } else {
          const clean = sanitizeExportText(node.value, terms);
          if (clean !== node.value) {
            drop(parent);
            warnings.push({
              kind: "privacy-removed-script",
              ref: "inline script",
              reason: "The script contains identifying text.",
            });
          }
        }
      } else if (parent?.tagName !== "style") node.value = sanitizeExportText(node.value, terms);
      return;
    }
    if (!node.tagName) return;
    if (get(node, "data-export-private") !== undefined || ["base", "metadata"].includes(node.tagName)) {
      drop(node);
      return;
    }
    if (
      node.tagName === "meta" &&
      !get(node, "charset") &&
      get(node, "name") !== "viewport" &&
      get(node, "http-equiv")?.toLowerCase() !== "content-security-policy"
    ) {
      drop(node);
      return;
    }
    for (const attr of [...node.attrs]) {
      const name = attr.name;
      if (resources.has(attr.value)) continue;
      if (
        name.startsWith("data-export-") ||
        name.startsWith("data-lavish-") ||
        name.startsWith("on") ||
        ["srcdoc", "integrity", "crossorigin"].includes(name)
      ) {
        remove(node, name);
        continue;
      }
      if (attr.value.startsWith("data:")) {
        attr.value = sanitizeDataUri(attr.value, terms, cache, warnings);
        continue;
      }
      if (["src", "href", "poster", "action", "formaction", "data", "srcset", "ping"].includes(name)) {
        if (attr.value.startsWith("#") || attr.value === "about:blank") continue;
        if (node.tagName === "script" || node.tagName === "link") drop(node);
        else attr.value = "about:blank";
        warnings.push({
          kind: "privacy-removed-resource",
          ref: node.tagName,
          reason: "An external or unresolved reference was removed.",
        });
      } else if (name === "style") attr.value = cleanCss(attr.value, terms, prefix);
      else if (!["id", "class"].includes(name)) attr.value = sanitizeExportText(attr.value, terms);
    }
    if (node.tagName === "style")
      for (const child of node.childNodes || []) if (child.value) child.value = cleanCss(child.value, terms, prefix);
  });
  let svg;
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(source))
    visit(document, (node) => {
      if (!svg && node.tagName === "svg") svg = node;
    });
  const html = restore(svg ? serializeOuter(svg) : serialize(document));
  return { html, document };
}

function maskDataUris(source, transform = (value) => value) {
  const resources = new Map();
  const tokens = new Map();
  let prefix = "urn:export-embedded:";
  while (source.includes(prefix)) prefix += "x";
  const masked = source.replace(/data:[a-z0-9.+/-]+(?:;[a-z0-9=._-]+)*,[^\s"'<>)]*/gi, (value) => {
    if (tokens.has(value)) return tokens.get(value);
    const token = prefix + resources.size;
    resources.set(token, transform(value));
    tokens.set(value, token);
    return token;
  });
  const restore = (html) =>
    html.replace(new RegExp(escapeRegex(prefix) + "\\d+", "g"), (token) => resources.get(token) || "about:blank");
  return { masked, resources, prefix, restore };
}

function cleanCss(css, terms, resourcePrefix = "urn:export-embedded:") {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (whole, double, single, bare) => {
      const value = String(double ?? single ?? bare).trim();
      return value.startsWith("data:") || value.startsWith(resourcePrefix) ? whole : 'url("about:blank")';
    })
    .replace(/@import[^;]+;/gi, "")
    .replace(/(["'])([^"']+)\1/g, (whole, quote, value) =>
      value.startsWith("data:") ? whole : `${quote}${sanitizeExportText(value, terms)}${quote}`,
    );
}

const DOWNLOAD_SCRIPT = `<script>(function(){document.addEventListener("click",function(event){var link=event.target.closest("a[download]");if(!link||!link.href.startsWith("data:"))return;event.preventDefault();var value=link.getAttribute("href"),comma=value.indexOf(","),meta=value.slice(5,comma),raw=meta.includes(";base64")?atob(value.slice(comma+1)):decodeURIComponent(value.slice(comma+1));var bytes=Uint8Array.from(raw,function(c){return c.charCodeAt(0)}),url=URL.createObjectURL(new Blob([bytes],{type:meta.split(";")[0]})),copy=document.createElement("a");copy.href=url;copy.download=link.getAttribute("download")||"attachment";document.body.appendChild(copy);copy.click();copy.remove();setTimeout(function(){URL.revokeObjectURL(url)},60000);});})();</script>`;

/** Build a sanitized offline export. Never modify or upload the source artifact. */
export async function buildPrivateExportHtml(source, options = {}) {
  const input = maskDataUris(source);
  const document = parse(input.masked);
  const terms = [];
  const aliases = new Map();
  let downloadIndex = 0;
  visit(document, (node) => {
    if (node.tagName === "meta" && get(node, "name") === "lavish-export-redact") {
      try {
        const values = JSON.parse(get(node, "content") || "[]");
        if (Array.isArray(values)) terms.push(...values.filter((v) => typeof v === "string" && v.length));
      } catch {
        throw new Error("Invalid export redaction terms");
      }
    }
    for (const attr of ["src", "href", "poster"]) {
      const replacement = get(node, "data-export-" + attr);
      if (replacement !== undefined && get(node, attr)) aliases.set(get(node, attr), replacement);
    }
  });
  visit(document, (node) => {
    if (get(node, "data-export-private") !== undefined) {
      drop(node);
      return;
    }
    for (const attr of node.attrs || [])
      if (["src", "href", "poster"].includes(attr.name) && aliases.has(attr.value))
        attr.value = aliases.get(attr.value);
    if (node.tagName === "a" && get(node, "download") !== undefined) {
      const ref = get(node, "href") || "";
      const originalRef = input.resources.get(ref) || ref;
      const extension = /^data:([^;,]+)/.exec(originalRef)?.[1];
      const ext = extension
        ? { "application/json": ".json", "text/plain": ".txt", "video/mp4": ".mp4", "image/png": ".png" }[extension] ||
          ".bin"
        : path.extname(ref.split(/[?#]/)[0]).replace(/[^a-z0-9.]/gi, "");
      set(node, "download", `attachment-${++downloadIndex}${ext || ".bin"}`);
    }
  });
  const warnings = [];
  const root = options.confineDir || options.baseDir || process.cwd();
  const cache = new Map();
  const readLocalFile = async (absPath, limits) => {
    if (cache.has(absPath)) return cache.get(absPath);
    const buffer = Buffer.from(await readConfinedFile(absPath, limits.allowOutsideRoot ? null : root, limits));
    const mime = MIME[path.extname(absPath).toLowerCase()];
    let clean;
    if (TEXT_EXTENSIONS.test(absPath)) clean = cleanTextFile(buffer, mime || "text/plain", terms);
    else if (mime && mime !== "image/svg+xml") clean = stripMediaMetadata(buffer, mime);
    else if (/\.(?:css|js|mjs|svg|woff2?|ttf|otf|eot)$/i.test(absPath)) clean = buffer;
    else throw new Error("Unsupported attachment format for private export");
    cache.set(absPath, clean);
    return clean;
  };
  const bundled = await buildSelfContainedHtml(input.restore(serialize(document)), {
    ...options,
    readLocalFile,
    inlineDownloads: true,
    maxAssetBytes: options.maxAssetBytes ?? Number(process.env.LAVISH_AXI_EXPORT_MAX_ASSET_BYTES || 64 * 1024 * 1024),
    maxBundleBytes:
      options.maxBundleBytes ?? Number(process.env.LAVISH_AXI_EXPORT_MAX_BUNDLE_BYTES || 256 * 1024 * 1024),
  });
  warnings.push(
    ...bundled.warnings.map((w) => ({
      kind: w.kind,
      ref: "attachment",
      ...(w.reason ? { reason: sanitizeExportText(w.reason, terms) } : {}),
    })),
  );
  let { html } = sanitizeDocument(bundled.html, terms, warnings);
  const notice =
    '<aside role="note" style="padding:12px;margin:12px;border:1px solid #ddd;font:14px/1.5 system-ui">Sanitized export. Service identifiers, recognized credentials, and media metadata are removed. Attachments are sanitized copies. Review visible media before sharing.</aside>';
  html = html.replace(/<body([^>]*)>/i, `<body$1>${notice}`).replace(/<\/body>/i, DOWNLOAD_SCRIPT + "</body>");
  return { html, warnings };
}
