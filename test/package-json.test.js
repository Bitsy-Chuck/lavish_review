import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("check script runs all verification commands", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const checkCommands = packageJson.scripts.check.split(" && ");

  assert.deepEqual(checkCommands, [
    "npm run build",
    "npm run lint",
    "npm run format:check",
    "npm run typecheck",
    "npm test",
    "node scripts/build-skill.js --check",
  ]);
});

test("installable skill stays in sync with the no-args home output", async () => {
  const { createSkillMarkdown } = await import("../src/skill.js");
  const committed = await readFile(new URL("../skills/lavish/SKILL.md", import.meta.url), "utf8");

  assert.equal(committed, createSkillMarkdown(), "run `npm run build:skill` and commit the result");
});

test("published package includes the installable skill", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(packageJson.files.includes("skills/lavish"));
});

test("lavish-design agent skill is marked internal for skills CLI discovery", async () => {
  const skillMd = await readFile(new URL("../.agents/skills/lavish-design/SKILL.md", import.meta.url), "utf8");
  const frontmatter = skillMd.slice(4, skillMd.indexOf("\n---\n", 4));

  assert.match(frontmatter, /^name: lavish-design$/m);
  assert.match(frontmatter, /^metadata:\n {2}internal: true$/m);
});

test("public lavish skill is not marked internal", async () => {
  const skillMd = await readFile(new URL("../skills/lavish/SKILL.md", import.meta.url), "utf8");
  const frontmatter = skillMd.slice(4, skillMd.indexOf("\n---\n", 4));

  assert.doesNotMatch(frontmatter, /^metadata:\n {2}internal: true$/m);
});

test("build copies local design assets for published artifact injection", async () => {
  const buildScript = await readFile(new URL("../scripts/build.js", import.meta.url), "utf8");

  assert.match(buildScript, /daisyui\.css/);
  assert.match(buildScript, /daisyui-themes\.css/);
  assert.match(buildScript, /tailwindcss-browser\.js/);
});

// This checkout is local-only and is never published. The npm registry carries an unrelated
// lineage of `lavish-axi` that does not contain this repository's work, so anything that could
// publish from here - or pull that package back in - has to stay gone rather than merely unused.
test("the package cannot be published to the npm registry", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  // `private: true` alone is NOT sufficient: npm 11 still walks a `npm publish --dry-run` on a
  // private package through to a successful pack. The prepublishOnly script is the guard that
  // actually fails the command, so it is the one that has to stay.
  assert.match(packageJson.scripts.prepublishOnly, /process\.exit\(1\)/, "publishing must fail loudly");
  assert.equal(packageJson.private, true, "private: true is the declarative half of the same intent");
  assert.equal(packageJson.publishConfig, undefined, "publishConfig only means something when publishing");
});

test("package metadata points at this fork and nothing upstream", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.repository.url, "git+https://github.com/Bitsy-Chuck/lavish_review.git");
  assert.equal(JSON.stringify(packageJson).includes("kunchenguid"), false, "no upstream URL survives in the manifest");
});

test("pnpm lock root importer matches the publish manifest", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const pnpmLock = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");

  for (const [name, specifier] of Object.entries(packageJson.dependencies)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedSpecifier = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    assert.match(pnpmLock, new RegExp(`["']?${escapedName}["']?:[\\s\\S]*?specifier: ${escapedSpecifier}`));
  }
});

test("no workflow can publish the package or reach an upstream service", async () => {
  const dir = new URL("../.github/workflows/", import.meta.url);

  for (const name of await readdir(dir)) {
    const workflow = await readFile(new URL(name, dir), "utf8");
    assert.equal(workflow.includes("npm publish"), false, `${name} must not publish`);
    assert.equal(workflow.includes("kunchenguid"), false, `${name} must not reference upstream`);
  }
});

// The CLI used to ship an Umami analytics client that reported every invocation to the upstream
// author's server. It is gone, not merely disabled - so this asserts absence across the whole
// source tree rather than trusting one config value to stay falsy.
test("no telemetry or analytics client survives anywhere in the source", async () => {
  const roots = ["../src/", "../scripts/", "../bin/"];

  for (const root of roots) {
    const dir = new URL(root, import.meta.url);
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".js")) continue;
      const source = await readFile(new URL(name, dir), "utf8");
      for (const forbidden of ["umami", "UMAMI", "telemetry", "Telemetry", "kunchenguid"]) {
        assert.equal(source.includes(forbidden), false, `${root}${name} must not mention ${forbidden}`);
      }
    }
  }
});
