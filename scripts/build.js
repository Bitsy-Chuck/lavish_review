import { chmod, cp, copyFile, mkdir, readFile, rm } from "node:fs/promises";

import * as esbuild from "esbuild";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await mkdir("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["bin/lavish-axi.js"],
  outfile: "dist/cli.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  define: {
    "process.env.LAVISH_AXI_BUILD_UMAMI_HOST": JSON.stringify(process.env.LAVISH_AXI_UMAMI_HOST || ""),
    "process.env.LAVISH_AXI_BUILD_UMAMI_WEBSITE_ID": JSON.stringify(process.env.LAVISH_AXI_UMAMI_WEBSITE_ID || ""),
    "process.env.LAVISH_AXI_BUILD_VERSION": JSON.stringify(packageJson.version),
  },
});

await chmod("dist/cli.mjs", 0o755);
await copyFile("src/chrome-client.js", "dist/chrome-client.js");
await copyFile("src/chrome.css", "dist/chrome.css");
await mkdir("dist/design", { recursive: true });
await copyFile("node_modules/daisyui/daisyui.css", "dist/design/daisyui.css");
await copyFile("node_modules/daisyui/themes.css", "dist/design/daisyui-themes.css");
await copyFile("node_modules/@tailwindcss/browser/dist/index.global.js", "dist/design/tailwindcss-browser.js");
await copyFile("node_modules/mermaid/dist/mermaid.esm.min.mjs", "dist/design/mermaid.esm.min.mjs");
// Mermaid lazy-loads each diagram type via relative dynamic import() at render time (e.g.
// `import("./chunks/mermaid.esm.min/flowDiagram-*.mjs")`), so the chunk tree has to be vendored
// alongside the entry file for local rendering to stay fully offline. Purge any previously copied
// chunks first so a Mermaid upgrade that renames content-hashed chunks can't leave orphans behind.
await rm("dist/design/chunks", { recursive: true, force: true });
await cp("node_modules/mermaid/dist/chunks/mermaid.esm.min", "dist/design/chunks/mermaid.esm.min", {
  recursive: true,
});
