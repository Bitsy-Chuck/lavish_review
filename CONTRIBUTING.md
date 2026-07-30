# Contributing

This checkout is **local-only**. There is no upstream contribution process to follow here, and
nothing in it is published.

## Ground rules

- Work directly on local `main`, or on a local branch you merge into it. Nothing is pushed.
- The package is `private: true` and has no publish workflow. Do not add one, and do not install
  or invoke `lavish-axi` through `npx` - the registry package is a separate upstream lineage that
  does not contain this repository's work.
- `lavish-axi` on your PATH must resolve to this checkout's `dist/cli.mjs` (via `npm link`).
  Verify with `readlink -f "$(which lavish-axi)"`.

## Before you commit

```sh
pnpm run check
```

That runs build, lint, format check, typecheck, tests, and the skill freshness check. Keep it
green - it is the only gate, since no CI runs on your work.

Use TDD for bug fixes and new features: write the failing test first, then the fix.

## After changing agent-facing guidance

Guidance strings in `src/cli.js`, `src/design-reference.js`, and `src/playbooks.js` feed the
generated skill. When you change them:

```sh
pnpm run build:skill
cp skills/lavish/SKILL.md ~/.claude/skills/lavish/SKILL.md
cp skills/lavish/SKILL.md ~/.agents/skills/lavish/SKILL.md
```

Otherwise the installed skill silently drifts from the build.

## Repo conventions

- Node 22+, ESM-only JavaScript, and TypeScript `checkJs` validation.
- Do not reformat repo-provided `.agents/` skill content; `.prettierignore` excludes it intentionally.
- `CHANGELOG.md` is frozen history from when release automation still ran here. Leave it as-is
  rather than extending it.
- There is no telemetry. The upstream Umami client was deleted, and a test fails if any analytics
  or usage reporting reappears under `src/`, `scripts/`, or `bin/`. Do not add one back.
