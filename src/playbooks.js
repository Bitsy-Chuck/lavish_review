export const PLAYBOOK_ROUTER_INSTRUCTION =
  "MUST open each matching playbook before writing HTML. Match against the use_when trigger; one artifact often combines several playbooks.";

export const PLAYBOOK_ROUTER_HELP =
  "One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.";

export const PLAYBOOKS = [
  {
    id: "diagram",
    use_when: "Map relationships, messages, state, data models, timelines, hierarchy, or architecture",
    choose: [
      "Choose from the content shape before choosing a renderer: branching or converging paths -> flowchart; messages between actors over time -> sequenceDiagram; modes, transitions, or guards -> stateDiagram-v2; tables, keys, or cardinality -> erDiagram; types, fields, or inheritance -> classDiagram.",
      "For other shapes: dated milestones -> timeline; durations and dependencies -> gantt; two-axis positioning -> quadrantChart; hierarchy or taxonomy -> mindmap; user experience stages -> journey; flow with magnitude -> sankey-beta; work by status -> kanban; multivariate profiles -> radar-beta; nested part-to-whole -> treemap-beta; compositional wiring -> block-beta; deployed services and boundaries -> architecture-beta; software context/container views -> C4Context.",
      "N options by M criteria -> a TABLE, never a diagram. Quantities or trends -> a chart, not Mermaid. If no row in this rubric matches, use a table, a list, or SVG.",
      "After choosing a diagram type, use Mermaid when automatic placement and edge routing fit it. Use hand-authored SVG for a bespoke spatial figure; do not build boxes-and-arrows from div/flexbox.",
    ],
    structure: [
      "Lead with the question the diagram answers, not with the implementation detail that produced it.",
      "Use 5-12 nodes, with a hard ceiling of 20. If the system is larger, show a small overview and put dense evidence or module detail below it.",
      "Use no more than 3 subgraphs. Name them for meaningful system or organizational boundaries, not files, and set direction explicitly inside every subgraph.",
      "Always ship a linear text fallback. Never place two diagrams side by side.",
      "Add accTitle and accDescr to every Mermaid type that emits them. In Mermaid 11.15, mindmap, sankey, and block reject those directives; kanban parses but drops them; C4Context emits accDescr only. For those exceptions, provide the same accessible name/description in surrounding semantic HTML. Every diagram's visible caption must state the conclusion in prose, not merely name the figure.",
    ],
    design_rules: [
      "Use page-scoped class names and avoid generic names like .node that can collide with diagram libraries.",
      "Keep node labels to 1-4 words and at most 24 characters. Use markdown-string labels and let them wrap: NEVER put <br/> in labels. Keep edge labels to 3 words or fewer and add them only where the reader would otherwise guess wrong. Use no emoji in labels.",
      "Use TD for pipelines, hierarchies, and anything that must survive a phone. Use LR only when nodes are wide or the graph fans out; LR is a deliberate horizontal-scroll decision, not a default.",
      "At 390px, allow no more than 4 nodes across the widest rank. Otherwise wrap the diagram in overflow-x:auto, set Mermaid useMaxWidth:false, and set max-width:none on that wrapper's svg; the optional layout-safety CSS otherwise restores max-width:100% and defeats scrolling. useMaxWidth:true silently shrinks wide diagrams until their text is unreadable.",
      "NEVER hardcode hex colors in style, classDef, or linkStyle: hardcoded literals survive theme re-rendering and clash after a DaisyUI theme switch. Derive colors from DaisyUI tokens, use at most 2 semantic classes, prefer shape over color, and never make color the only carrier of meaning.",
      "Use the theme-aware `lavish-axi design` Mermaid snippet, which derives the palette from DaisyUI tokens and re-renders on every page theme change. Do not set theme or themeVariables in Mermaid frontmatter because the snippet owns them.",
      'Mermaid configuration can be global in mermaid.initialize(...) or local as the first line of one diagram: %%{init: {"look":"handDrawn","layout":"dagre","flowchart":{"useMaxWidth":false}}}%%. `look: handDrawn` requests sketch geometry (support varies by type); `layout` selects a registered engine. This vendored build registers dagre and cose-bilkent, not ELK. The %%{init}%% directive scopes overrides to that diagram. Never put theme or themeVariables there: the design snippet owns theme-derived colors.',
      "For a sketch treatment, use look: handDrawn and a fixed handDrawnSeed. It applies to flowchart, state-v2, class-v2, ER, requirement, kanban, and mindmap, but not sequence, block, or architecture.",
    ],
    pitfalls: [
      "NEVER diagram fewer than 4 nodes, a zero-branch linear chain, labels longer than about 6 words each, uniform records, or merely because 'artifacts should have a diagram'. A linear A -> B -> C chain is a numbered list; catchup.html is the cautionary case.",
      "Do not hand-build boxes-and-arrows from div/flexbox for a flow: it does not auto-route edges and reads worse than Mermaid; reach for Mermaid or SVG for richly annotated nodes.",
      "Do not cram every file or function into one diagram when a layered explanation would be clearer.",
      "Do not present unverified architecture claims as facts. Cite the files or commands that support them.",
    ],
    lavish_notes: [
      "A Lavish diagram should invite precise annotation: make modules, edges, and captions easy to click and discuss.",
      "@excalidraw/mermaid-to-excalidraw 2.2.2 natively parses only flowchart, sequence, class, ER, and state into EDITABLE Excalidraw shapes. It is pinned to Mermaid 11.12.1 with a scoped override because 11.13.0+ degrades conversion (upstream issue #108 remains open). Every richer Mermaid type becomes a static image: reviewers can draw on it, but cannot edit it as a graph. Prefer a convertible type when structural edits matter, but never misrepresent the content shape to gain editability.",
      "When a relationship is uncertain, label it as a question so the user can resolve it in the review loop.",
    ],
    syntax_examples: [
      "flowchart — `flowchart TD\\n  accTitle: Request routing\\n  accDescr: A request branches to cache or origin and converges at response.\\n  R[Request] --> C{Cached?}\\n  C -->|yes| H[Cache hit]\\n  C -->|no| O[Origin]\\n  H --> S[Response]\\n  O --> S`",
      "sequence — `sequenceDiagram\\n  accTitle: Sign-in exchange\\n  accDescr: Browser asks the API to validate a session with the identity service.\\n  actor B as Browser\\n  participant A as API\\n  participant I as Identity\\n  B->>A: Sign in\\n  A->>I: Validate\\n  I-->>A: Session\\n  A-->>B: Continue`",
      "state — `stateDiagram-v2\\n  accTitle: Review states\\n  accDescr: A draft enters review and is either revised or approved.\\n  [*] --> Draft\\n  Draft --> Review: submit\\n  Review --> Draft: revise\\n  Review --> Approved: accept\\n  Approved --> [*]`",
      "ER — `erDiagram\\n  accTitle: Order records\\n  accDescr: A customer places orders and each order contains line items.\\n  CUSTOMER ||--o{ ORDER : places\\n  ORDER ||--|{ LINE_ITEM : contains\\n  CUSTOMER { string id PK }\\n  ORDER { string id PK }\\n  LINE_ITEM { string sku FK }`",
      "class — `classDiagram\\n  accTitle: Notification types\\n  accDescr: Email and push notifications implement a shared delivery operation.\\n  class Notice { +deliver() }\\n  class Email\\n  class Push\\n  Notice <|-- Email\\n  Notice <|-- Push`",
      "timeline — `timeline\\n  accTitle: Release milestones\\n  accDescr: The release moves from research through beta to general availability.\\n  title Release path\\n  2026-08 : Research\\n  2026-09 : Beta\\n  2026-10 : General access`",
      "gantt — `gantt\\n  accTitle: Launch schedule\\n  accDescr: Build follows design and validation follows build.\\n  title Launch plan\\n  dateFormat YYYY-MM-DD\\n  section Delivery\\n  Design :d, 2026-08-01, 5d\\n  Build :b, after d, 10d\\n  Validate :after b, 4d`",
      "quadrant — `quadrantChart\\n  accTitle: Initiative priority\\n  accDescr: Initiatives are positioned by effort and user value.\\n  x-axis Low effort --> High effort\\n  y-axis Low value --> High value\\n  quadrant-1 Strategic\\n  quadrant-2 Quick wins\\n  Search: [0.25, 0.80]\\n  Migration: [0.78, 0.72]`",
      "mindmap — `mindmap\\n  root((Research))\\n    Users\\n      Interviews\\n      Surveys\\n    Market\\n      Trends\\n      Rivals` (pair it with adjacent plain text for accessibility because this syntax has no accTitle/accDescr directives)",
      "journey — `journey\\n  accTitle: Checkout experience\\n  accDescr: The shopper is happiest browsing and struggles during payment.\\n  title Checkout\\n  section Shop\\n    Browse: 5: Shopper\\n    Cart: 4: Shopper\\n  section Pay\\n    Payment: 2: Shopper`",
      "sankey — `sankey-beta\\n  Traffic,Signup,60\\n  Traffic,Leave,40\\n  Signup,Active,45\\n  Signup,Leave,15` (add an accessible caption and adjacent plain-text fallback; Sankey syntax has no accTitle/accDescr directives)",
      "kanban — `kanban\\n  queued[Queued]\\n    spec[Write spec]\\n  active[Active]\\n    build[Build UI]\\n  done[Done]\\n    audit[Run audit]` (add an accessible HTML caption and adjacent plain text; Mermaid 11.15 parses accTitle/accDescr here but does not emit SVG accessibility metadata)",
      "radar — `radar-beta\\n  accTitle: Quality profile\\n  accDescr: Current and target quality across five dimensions.\\n  title Quality profile\\n  axis speed, clarity, access, safety, reach\\n  curve current{3, 4, 5, 4, 2}\\n  curve target{4, 5, 5, 5, 4}`",
      'treemap — `treemap-beta\\n  accTitle: Product allocation\\n  accDescr: Core receives over half of product investment.\\n  "Product"\\n    "Core": 55\\n    "Growth": 25\\n    "Platform": 20`',
      'block — `block-beta\\n  columns 3\\n  input["Input"] space:1 proc["Transform"]\\n  space:2 output["Output"]\\n  input --> proc --> output` (add an accessible caption and adjacent plain text; block syntax has no accTitle/accDescr directives)',
      "architecture — `architecture-beta\\n  accTitle: Cloud services\\n  accDescr: The API reads and writes the data service inside one cloud boundary.\\n  group cloud(cloud)[Cloud]\\n  service api(server)[API] in cloud\\n  service db(database)[Data] in cloud\\n  api:R --> L:db`",
      'C4 — `C4Context\\n  accDescr: A user reviews artifacts that Lavish reads from a repository.\\n  title System context\\n  Person(user, "User", "Reviews work")\\n  System(app, "Lavish", "Shows artifacts")\\n  System_Ext(repo, "Repository", "Stores source")\\n  Rel(user, app, "Reviews")\\n  Rel(app, repo, "Reads")` (C4Context honors accDescr but not accTitle; keep the visible title and adjacent plain-text fallback)',
      "plain-text fallback — `Fallback: Request → cache check; a hit returns immediately, while a miss calls origin; both paths return a response.` Place it immediately after every diagram, visually compact but available to assistive technology.",
    ],
  },
  {
    id: "table",
    use_when: "Turn dense records into scan-friendly review surfaces",
    choose: [
      "Use a table when rows share the same fields and the user needs to compare evidence quickly.",
      "Use cards when each record has a different shape or needs a long explanation.",
      "Use summaries above the table when counts, risk levels, or statuses change how the table should be read.",
    ],
    structure: [
      "Start with a short summary of what the rows prove or require.",
      "Group columns by the decision they support: identity, evidence, status, action.",
      "Keep raw details available, but make the primary status visible without reading every cell.",
    ],
    design_rules: [
      "Use semantic table markup when the data is tabular.",
      "Protect long paths, code symbols, URLs, and prose from overflowing on narrow screens.",
      "Use restrained color for status and severity so the table remains readable when printed or skimmed.",
    ],
    pitfalls: [
      "Do not paste a terminal table into HTML and call it done.",
      "Do not hide the important conclusion below a large undifferentiated grid.",
      "Do not use color as the only status signal.",
    ],
    lavish_notes: [
      "A Lavish table should make individual rows easy annotation targets.",
      "If a row implies a follow-up change, include an action control that queues a specific prompt.",
    ],
  },
  {
    id: "comparison",
    use_when: "Show options, tradeoffs, and current vs target behavior",
    choose: [
      "Use before and after when the same system is changing over time.",
      "Use option cards when the user needs to choose between mutually exclusive directions.",
      "Use a scorecard only when the criteria are explicit and comparable.",
    ],
    structure: [
      "Name the decision at the top of the artifact.",
      "Show the concrete behavior or artifact shape for each side, not just abstract pros and cons.",
      "End with a recommendation only when the evidence actually supports one.",
    ],
    design_rules: [
      "Keep corresponding details aligned so differences are visible without hunting.",
      "Use visual hierarchy to separate primary tradeoffs from secondary notes.",
      "Make the cost of each option as visible as the benefit.",
    ],
    pitfalls: [
      "Do not make every option look equally recommended if one is clearly preferred.",
      "Do not compare vague summaries when concrete examples are available.",
      "Do not bury assumptions that would change the recommendation.",
    ],
    lavish_notes: [
      "A Lavish comparison should let the user annotate the exact option or tradeoff they want changed.",
      "If the goal is selection, provide controls that queue the chosen option with rationale.",
    ],
  },
  {
    id: "plan",
    use_when: "Explain a product or technical plan before implementation",
    choose: [
      "Use this when the user needs to inspect a feature approach before implementation begins.",
      "Use it when the user explicitly asked for a PRD, technical design, implementation plan or proposal.",
      "Use a lighter comparison or diagram playbook when the plan is only a single small design choice.",
    ],
    structure: [
      "Start with the goal, the current state, and desired behavior.",
      "Then describe a proposed approach, focusing on high level decisions.",
      "At the end, list any risks you see, and open questions you have, and follow the 'comparison' playbook to provide options for the user to choose from.",
    ],
    design_rules: [
      "Verify each claim against the codebase before presenting it as fact.",
      "When discussing frontend experiences, prefer visually mocking the experience under a consistent design system as the real product over describing it with text.",
      "The plan needs to be self-contained enough that another developer can read it and fully implement the proposal.",
    ],
    pitfalls: [
      "Do not leave resolved open questions in the artifact. Update existing content to reflect the decision and remove the open question.",
      "Do not only focus on ambiguous decisions and omit the actual proposal.",
      "Do not omit failure modes, migration concerns, or backwards compatibility questions.",
    ],
    lavish_notes: ["A Lavish plan should make a plan and its uncertainties easy to annotate before code exists."],
  },
  {
    id: "code",
    use_when: "Render source code, code files, patches, PR diffs, and before/after code inside Lavish artifacts",
    choose: [
      "Use this whenever an artifact shows source code: a snippet, full file, patch, PR diff, local change set, or before/after code.",
      "Use File for one code file, FileDiff for old/new versions or parsed patch metadata, and CodeView only when several files or diffs need coordinated navigation.",
      "Choose split layout for careful side-by-side review when width allows; choose unified layout when space is tight, changes are mostly additive, or mobile readability matters.",
    ],
    structure: [
      "Place the path, language, and reason to inspect the code immediately before each rendered file or diff.",
      "Keep evidence close to each claim with file paths, line references, or annotations next to the relevant code.",
      "For multi-file changes, group files by user-facing area or task instead of dumping a raw patch in repository order.",
    ],
    design_rules: [
      `Rendering MUST use @pierre/diffs, not hand-rolled <pre> blocks or another diff library. This verified no-build standalone HTML snippet renders one file and one split diff from esm.sh:
\`\`\`html
<div id="file"></div>
<div id="diff"></div>
<script type="module">
  import { File, FileDiff } from "https://esm.sh/@pierre/diffs@1.2.10?bundle";

  const theme = { light: "github-light", dark: "github-dark" };
  const options = { theme, themeType: "dark", overflow: "wrap" };
  const oldFile = {
    name: "src/greeting.ts",
    contents: "export function greet(name: string) {\\n  return \\"Hello \\" + name;\\n}\\n\\nconsole.log(greet(\\"Lavish\\"));\\n",
  };
  const newFile = {
    name: "src/greeting.ts",
    contents: "export function greet(name: string) {\\n  return \\"Hello, \\" + name + \\"!\\";\\n}\\n\\nconsole.log(greet(\\"Lavish\\"));\\n",
  };

  new File(options).render({
    containerWrapper: document.querySelector("#file"),
    file: newFile,
  });

  new FileDiff({ ...options, diffStyle: "split" }).render({
    containerWrapper: document.querySelector("#diff"),
    oldFile,
    newFile,
  });

</script>
\`\`\``,
      "Pick a Shiki theme pair that matches the artifact's DaisyUI or Tailwind direction and light or dark mode; replace the GitHub pair above when the page is not GitHub-like.",
      'Use FileDiff diffStyle: "split" for side-by-side review and diffStyle: "unified" for stacked reading; keep overflow: "wrap" unless horizontal alignment is essential.',
      "Use @pierre/diffs line annotations, selections, and headers when calling out specific lines so notes stay attached to code.",
    ],
    pitfalls: [
      "Do not render code as static screenshots, plain <pre> blocks, or markdown pasted into HTML.",
      "Do not choose an arbitrary default Shiki theme that clashes with the page palette or dark mode.",
      "Do not show huge unrelated files when a focused render range, parsed patch file, or grouped summary would be clearer.",
      "Do not separate a claim from the code lines that prove it.",
    ],
    lavish_notes: [
      "A Lavish code artifact should make each file, hunk, and relevant line easy to annotate precisely.",
      "When a user action should trigger a fix, queue prompts that name the file path, line range, and desired change.",
      "If the artifact combines code with a plan, table, or comparison, read those playbooks too and keep @pierre/diffs responsible for the code surface.",
    ],
  },
  {
    id: "input",
    use_when:
      "Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact",
    choose: [
      "Use this when the user needs to select, tune, triage, annotate, or edit a structured choice.",
      "Use controls for decisions the user can make faster visually than by writing a prompt.",
      "Use plain annotations when the artifact only needs open-ended feedback.",
    ],
    structure: [
      "Make each decision surface visible: what is being chosen, what the options mean, and what happens next.",
      "Keep reversible selection state local in the artifact until the user explicitly submits that question.",
      "Pair each question with a Submit or Queue answer control that sends exactly one prompt for the final answer.",
      "Show selected state separately from queued state so the user trusts what will be sent back.",
    ],
    design_rules: [
      "Native controls - radios, checkboxes, text inputs, selects, textareas, buttons, options, labels, disclosure summaries, and contenteditable regions - are interactive automatically: clicks toggle, focus, and type instead of annotating, so they do not need data-lavish-action. Build choice and option UIs from these whenever you can.",
      "For reversible choices, do not call window.lavish.queuePrompt() from radio change handlers or option click handlers. Those handlers should only update local selected state.",
      "Use a per-question form submit or explicit Queue answer button to read the current values and call window.lavish.queuePrompt() exactly once for the final answer.",
      "Put data-lavish-action only on custom (non-native) elements that should act like a feedback control - typically a styled div or span you made clickable - so Lavish does not annotate it and shows a pointer cursor instead.",
      "Use data-lavish-question on a question wrapper or pass queueKey when multiple pre-send updates should replace the prior unsent answer for the same question.",
      "Pass options such as tag, text, selector, target, data, queueKey, or element when they help the agent understand exactly what the user chose.",
      "Call window.lavish.sendQueuedPrompts() only when the control should immediately send committed feedback instead of waiting for the user to press Send to Agent.",
      "Make queued prompts specific enough that the agent can act without asking a follow-up question.",
      "Keep native browser controls accessible and readable on mobile.",
    ],
    pitfalls: [
      "Do not queue one prompt per radio change, checkbox toggle, dropdown change, or choice-button click when the user can still change their mind.",
      "Do not create controls whose queued prompt is unclear or too vague to execute.",
      "Do not hide the difference between selected locally and queued for the agent.",
      "Do not require interaction for content the user only needs to read.",
    ],
    lavish_notes: [
      "Lavish is strongest when the artifact becomes a focused review surface and not just a static page.",
      'A native single-choice question should submit the final value: `<form data-lavish-question="plan" onsubmit="event.preventDefault(); const choice = new FormData(event.currentTarget).get(\'plan\'); if (choice) window.lavish.queuePrompt(\'Use the \' + choice + \' plan\', { tag: \'choice\', text: \'Plan: \' + choice, element: event.currentTarget, data: { question: \'plan\', answer: choice } });"><label><input type="radio" name="plan" value="Starter"> Starter</label><label><input type="radio" name="plan" value="Pro"> Pro</label><button type="submit">Queue this answer</button></form>`.',
      "A custom choice UI should make option buttons update local state, then use a separate Queue answer button with data-lavish-action to queue the final selected value.",
      "Use window.lavish.queuePrompt for user intent, not internal analytics or UI-only state changes.",
      "End input paths with an obvious way for the user to send feedback back to the agent.",
    ],
  },
  {
    id: "slides",
    use_when: "Create a deliberate presentation when slides are requested",
    choose: [
      "Use slides only when the user asks for a deck, presentation, talk, or paced walkthrough.",
      "Use a scroll page when the user needs reference material, detailed review, or dense evidence.",
      "Use one idea per slide when the artifact has a narrative arc.",
    ],
    structure: [
      "Plan the story before writing the slide markup.",
      "Open with the point, build context, show evidence, and close with the decision or next action.",
      "Vary slide composition so the deck does not feel like repeated cards.",
    ],
    design_rules: [
      "Keep slide text sparse and let visuals carry the explanation.",
      "Use large type, strong alignment, and deliberate whitespace rather than dense paragraphs.",
      "Make navigation and screen-size assumptions explicit in the artifact.",
    ],
    pitfalls: [
      "Do not turn every explainer into slides by default.",
      "Do not paste a scroll-page outline into fixed-size frames without rewriting the narrative.",
      "Do not make consecutive slides with the same spatial composition unless repetition is the point.",
    ],
    lavish_notes: [
      "A Lavish slide deck can still collect feedback, but each prompt should refer to a slide or decision.",
      "Use slides for persuasion or presentation, not for dense code review.",
    ],
  },
];

export function listPlaybooks() {
  return PLAYBOOKS.map(({ id, use_when }) => ({ id, use_when }));
}

export function findPlaybook(id) {
  return PLAYBOOKS.find((playbook) => playbook.id === id) || null;
}

export function playbookIds() {
  return PLAYBOOKS.map((playbook) => playbook.id);
}
