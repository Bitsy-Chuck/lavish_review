---
name: lavish
description: Turn complex or visual agent responses into rich, reviewable HTML artifacts the user can annotate and send feedback on, using the lavish-axi CLI. Use when about to give a plan, comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.
argument-hint: <what the artifact should show>
metadata:
  hermes:
    tags: [html, review, artifacts, visualization]
    category: productivity
---

# Lavish Editor

Lavish Editor helps agents turn rich HTML artifacts into collaborative human review surfaces. Whenever you are about to give user a complex response that will be easier to understand via a rich / interactive page, consider using Lavish Editor. First generate an interactive HTML artifact according to user request, then run `lavish-axi <html-file>` so the user can visually review it, annotate elements or selected text, queue prompts, and send feedback back through `lavish-axi poll`.

`lavish-axi` is a locally built and linked command, not a package to fetch from the public npm registry. Build it with `npm run build`, then put it on your PATH with `npm link` or `npm i -g .`, or invoke it directly as `node dist/cli.mjs <html-file>`. Every `lavish-axi ...` command below runs that local binary.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/lavish` explicitly - build an HTML artifact for that request now, following the workflow below.
If it is empty, infer what to visualize from the conversation.

## When to use

Use lavish-axi when the user asks for a visual artifact, HTML explainer, interactive prototype, review surface, product or technical plan, comparison, report, or browser-based feedback loop

## Workflow

1. Create the HTML artifact (default location `.lavish/<name>.html` in the working directory).
2. Run `lavish-axi <html-file>` to open or resume a review session in the browser.
3. Run `lavish-axi poll <html-file>` to long-poll for the user's annotations, queued prompts, and browser-reported `layout_warnings`.
   On the first poll, prefer `--agent-reply "<one-line summary of what you built and what to review first>"` so the conversation panel opens with context.
   The poll stays silent until the user acts or the real browser reports fresh layout warnings - leave it running, never kill it.
   If your harness limits how long a foreground command may run, run the poll as a background task; if it gets killed or times out anyway, just re-run it - queued feedback is never lost.
4. If poll returns `layout_warnings`, follow the returned `next_step`: fix and re-check fresh error-severity findings, but proceed with a note instead of looping when every current warning is persistent or low-severity.
5. Apply human feedback, then poll again with `--agent-reply "<message>"` to reply in the browser and keep the loop going.
6. Run `lavish-axi end <html-file>` when the review is finished.
7. If the user ends the session from the browser instead, `lavish-axi <html-file>` refuses to reopen it and says so - only pass `--reopen` when the user asks for further review or something genuinely important needs their visual attention. Otherwise deliver remaining updates directly in this conversation.

## Visual guidance

- Use visual hierarchy to make the most important decisions, risks, tradeoffs, and next actions obvious at a glance
- Use visual structure such as sections, cards, tables, diagrams, annotated snippets, and side-by-side comparisons instead of long prose
- Choose typography, spacing, color, and layout deliberately so the artifact has a clear point of view
- Prevent horizontal overflow at every nesting level: nested grid/flex children also need minmax(0, 1fr) tracks and min-width: 0, especially when badges, labels, or status text use wide pixel or monospace fonts; wrap, truncate, or contain long unbreakable text deliberately
- When the artifact would describe existing or current UI or state, show it instead: capture screenshots of the real pages (run the app read-only if needed) and embed them, rather than explaining the current look in prose; reserve prose for what cannot be shown such as rationale, trade-offs, and open questions
- You are NOT rendering into the full browser window - the artifact lives in an iframe beside Lavish's own chrome, so size for less than you can see. On desktop the artifact gets roughly `window width - 360px` (the Conversation panel; it narrows to 288px on windows under ~1200px wide) and `window height - 56px` (the top bar). At 860px wide and below the panel becomes a bottom sheet that starts collapsed, so the artifact gets the FULL width and `100dvh - 108px` of height (56px top bar + 52px collapsed sheet handle); when the reviewer opens the sheet it overlays the bottom `min(50dvh, 420px)` (half) or nearly the whole viewport (expanded) instead of resizing the artifact. Budget for a 360px-wide viewport at the low end.

## Responsive layout

Requirements, not suggestions - artifacts get reviewed on a phone as often as on a laptop.

- Design mobile-first and verify at 360px wide before adding any wider layout: write the single-column, full-bleed layout first, then add `sm:`/`md:`/`lg:` (or `min-width` media queries) to opt into multi-column. 360x640 is the minimum size an artifact must be readable and operable at, with no horizontal page scroll.
- Collapse every multi-column grid to one column on narrow screens - `grid-cols-1 md:grid-cols-3`, not a bare `grid-cols-3` - and give nested grid/flex tracks `minmax(0, 1fr)` and `min-width: 0` so a long token inside a cell cannot force the whole page wider.
- Tables need an explicit narrow-screen strategy, not just a wrapper: put the table in `overflow-x-auto` so it scrolls inside its own box, or restructure it into stacked label/value cards under `md:`. Never let a table set the page width.
- Use fluid type and spacing (`clamp()`, or the responsive text/spacing scale) so headings shrink with the viewport instead of overflowing it, and keep body copy at 16px or larger on mobile so phones do not zoom the form controls.
- Contain diagrams and SVG deliberately. Mermaid diagrams fit by default; when a diagram is genuinely too wide to read shrunk, initialize it with `useMaxWidth: false` AND wrap it in a horizontal scroll container (`overflow-x-auto`, `overflow-x-scroll`, or `data-lavish-scroll-x`), which is the one place Lavish's injected containment layer lets media exceed 100% width so the scrollbar actually appears.
- Every interactive control needs a touch target of at least 44x44 CSS pixels on a phone - buttons, links in button rows, close controls, tabs, and anything with `data-lavish-action`. Small icon-only controls should grow their hit area (padding, or an inset `::after` overlay) rather than shrink to the icon.
- Write `<meta name="viewport" content="width=device-width, initial-scale=1">` into the artifact head yourself. Lavish injects one when it is missing so a phone never lays the artifact out at the ~980px desktop fallback, but the saved file should stand on its own when opened straight from disk.

## Playbooks

Run `lavish-axi playbook <id>` for focused, detailed guidance on any of these.
One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
For relationships, messages, state, data models, timelines, hierarchy, or architecture, open the diagram playbook before choosing a visual form: it includes a diagram-type rubric and explicit cases where a table, list, chart, or SVG is better. After the content shape justifies Mermaid, use the theme-aware snippet from `lavish-axi design`; do not hand-build boxes-and-arrows from div/flexbox.

- `diagram` - Map relationships, messages, state, data models, timelines, hierarchy, or architecture
- `table` - Turn dense records into scan-friendly review surfaces
- `comparison` - Show options, tradeoffs, and current vs target behavior
- `plan` - Explain a product or technical plan before implementation
- `code` - Render source code, code files, patches, PR diffs, and before/after code inside Lavish artifacts
- `input` - Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact
- `slides` - Create a deliberate presentation when slides are requested

## Commands & rules

- Run `lavish-axi <html-file>` to open or resume a Lavish Editor session. If the user explicitly ended the session from the browser, this refuses to reopen it and explains why instead of reopening uninvited - pass `--reopen` only when the user asks for further review or something important needs their visual attention
- Unless the user specifies another location, create HTML artifacts in the current working directory under `.lavish/`
- Lavish serves the html file through a local express.js server. If your html needs to reference other filesystem assets such as images, CSS, fonts, and local scripts, copy them into the same directory as the HTML file, then reference them with relative paths from that directory. Never prepend `/` to those asset paths - root paths won't work
- Run `lavish-axi poll <html-file>` to wait for user feedback or browser-reported layout_warnings. It long-polls and stays silent until the user sends feedback, ends the session, or the real browser reports fresh layout_warnings, so leave it running - never kill it. Fix and re-check fresh error-severity layout_warnings before involving the human; if the poll says every current warning is persistent or low-severity, proceed with a note instead of looping. If your harness limits how long a foreground command may run, run the poll as a background task; if it gets killed or times out anyway, just re-run it - queued feedback is never lost. When it reports the session ended, stop polling and do not reopen it uninvited - deliver remaining updates in this conversation instead
- Rendered Mermaid diagrams in `.mermaid` containers become embedded, editable Excalidraw whiteboards in the browser (click a diagram to unlock editing; a Fullscreen action opens it over the whole viewport) - flowchart, sequence, class, ER, and state diagrams convert to editable shapes; other types embed as an image to draw on. Scenes autosave locally; when a reload detects a changed Mermaid source, the reviewer explicitly chooses to re-convert and discard saved edits or keep editing the saved scene. Standalone and exported copies still render plain Mermaid. Queue feedback adds a prompt to the Conversation panel; when the user sends it, poll returns a tag "whiteboard" prompt carrying a bounded edit summary plus local scenePath (.excalidraw JSON) and previewPath (PNG) files - read the summary first, open the files only when needed, then apply the edits by updating the Mermaid source in the artifact (never try to write the scene back)
- Run `lavish-axi end <html-file>` to end a session as the agent - ending it this way still allows a plain reopen later. When the user ends it from the browser instead, a later `lavish-axi <html-file>` refuses to reopen it without `--reopen`
- Run `lavish-axi export <html-file> [--out <path>]` to write a portable copy of the artifact - one HTML file with its LOCAL assets inlined - so it opens with no Lavish server and no sibling files. Remote CDN/font references are left as links, so it needs network to render those. Users can also export from the browser chrome's overflow menu
- Run `lavish-axi share <html-file> [--password <pw>] [--token <t>]` to publish the artifact on ht-ml.app (https://ht-ml.app), a third-party hosting service not part of Lavish, and get back a visitable URL. Shares are PUBLIC by default, so anyone with the link can open them. Pass --password to publish a PRIVATE password-protected page; viewers must supply the password to view. Local assets are inlined; remote refs load over the network. It returns the url plus a secret update_key for managing the page later. Use --token or LAVISH_AXI_HTML_APP_TOKEN only when you have an optional bearer token; it is never required. Users can also publish from the browser chrome's overflow menu
- Run `lavish-axi stop` to shut down the background server (it also self-stops when idle or after the last session ends with nothing connected)
- Run `lavish-axi playbook <playbook_id>` for focused artifact guidance. One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
- Lavish does not auto-inject any design system - no colors, spacing, typography, or components - so artifacts stay portable and render the way you wrote them when opened directly without lavish-axi running. (It does inject a viewport meta tag and a containment-only CSS base layer that any rule of yours overrides; run `lavish-axi design` for exactly what is in it and how to opt out.) Before writing any HTML: Decide the design direction in this strict priority order, and only move to the next step when the current one truly yields nothing: (1) if the user asked for a specific look or named design system, use that; (2) otherwise you must first inspect the project the artifact is about - the subject or product whose content or UI it represents, which may differ from your current working directory - and match that project's design system: Tailwind or theme config, shared CSS variables or design tokens, component library, brand assets, or existing styled pages. If the artifact previews, proposes, or mocks a specific app's UI, render it in that app's own design system so it faithfully shows the product, even when you are running in a different repo; (3) only when both steps come up empty, use the Lavish-recommended Tailwind CSS browser runtime v4 + DaisyUI v5, served locally by Lavish from its `/design/` routes as vendored assets with no network egress, and prefer that local design snippet over hand-writing styles unless explicitly instructed otherwise by the user. Run `lavish-axi design` for a content-to-playbook router, a copy-pasteable local design snippet, a Mermaid snippet/init for diagrams, and the DaisyUI component reference. These assets are vendored and served locally from Lavish's `/design/` routes - no CDN, no network egress. When you deliver the artifact, state which of the three design sources you used and why.
- Use lavish-axi when the user asks for a visual artifact, HTML explainer, interactive prototype, review surface, product or technical plan, comparison, report, or browser-based feedback loop
