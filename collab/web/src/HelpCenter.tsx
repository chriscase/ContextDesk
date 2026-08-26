import { CORPUS_INTAKE_LIMITS } from "@cd-collab/contracts/corpus-intake";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StageId } from "./Cases.js";

/** Areas the shell can genuinely navigate to from a help article. */
export type HelpAreaTarget = "overview" | "investigations" | "entities" | "sources" | "profile";

type HelpActionTarget = { area: HelpAreaTarget } | { stage: StageId };

interface HelpAction {
  label: string;
  go: HelpActionTarget;
}

interface HelpArticle {
  id: string;
  title: string;
  summary: string;
  keywords: readonly string[];
  what: string;
  when: string;
  steps: readonly string[];
  recorded: string;
  limits: string;
  actions?: readonly HelpAction[];
}

interface HelpCategory {
  id: string;
  title: string;
  articles: readonly HelpArticle[];
}

interface GlossaryEntry {
  term: string;
  definition: string;
}

const asMiB = (bytes: number) => bytes / (1024 * 1024);
const CORPUS_CAPACITY_COPY =
  `Archives are capped at ${asMiB(CORPUS_INTAKE_LIMITS.maxArchiveBytes)} MiB, `
  + `expanded bytes at ${asMiB(CORPUS_INTAKE_LIMITS.maxExpandedBytes)} MiB, `
  + `${CORPUS_INTAKE_LIMITS.maxFileCount.toLocaleString("en-US")} files, `
  + `path depth ${CORPUS_INTAKE_LIMITS.maxPathDepth}, `
  + `path length ${CORPUS_INTAKE_LIMITS.maxPathLength}, `
  + `${asMiB(CORPUS_INTAKE_LIMITS.maxFileBytes)} MiB per file, `
  + `compression ratio ${CORPUS_INTAKE_LIMITS.maxCompressionRatio}, and `
  + `${CORPUS_INTAKE_LIMITS.maxProcessingMs / 1_000} seconds of processing.`;

/**
 * All help content is plain structured data: no markdown runtime, no fetch.
 * Every claim below is scoped to what this build's code actually does —
 * articles state absences ("not part of this build") rather than promising
 * behavior that lives in other tools or future work.
 */
const HELP_CATEGORIES: readonly HelpCategory[] = [
  {
    id: "get-started",
    title: "Get started",
    articles: [
      {
        id: "war-room-basics",
        title: "What the War Room is",
        summary:
          "A shared workspace where a team records investigations and moves each one through Capture, Analyze, Compare, and Decide.",
        keywords: ["overview", "workflow", "stages", "orientation", "introduction"],
        what:
          "The War Room is the web workspace for ContextDesk investigations. Overview is the command center: recorded status counts, the latest cross-investigation activity, Open threads (recorded work that stopped, disagreed, is still unread, or is waiting on a decision), and high-impact active work — each with direct links to the work itself. Every activity row names the stage it belongs to, who or what produced it, and whether the record behind it is restricted. Investigations is the searchable case inventory and creation entry point. Opening an investigation focuses it and offers five stages: Situation (the shared picture), Capture (notes and imports), Analyze (evidence and AI lanes), Compare (lanes side by side), and Decide (the human call and export).",
        when:
          "Read this first if the navigation is unfamiliar, or when you want to know which stage a task belongs to.",
        steps: [
          "Open Overview to see what changed most recently across investigations, and what nothing has carried further yet.",
          "Read Open threads to find recorded work that stopped short, disagreed across lanes, has not been read, or is waiting on a human decision — each entry links straight to the record.",
          "Select an investigation to focus it; the Situation stage opens first.",
          "Use the stage strip or the Situation page's work-area links to move between Capture, Analyze, Compare, and Decide.",
          "Use the breadcrumb to return to Investigations or the Overview at any time.",
        ],
        recorded:
          "Overview and Situation restate only recorded facts. Overview's activity feed and Open threads are both human-readable projections of the same durable timeline events; opening an item takes you to the relevant investigation stage. Neither infers urgency or correctness from model output.",
        limits:
          "Counts and statuses reflect recorded state only — they never measure progress, completeness, or correctness, and no stage is ever marked \"done\" for you. Open threads is read from the most recent recorded events the page loaded, and says how many that was; older open work can sit outside that window.",
        actions: [
          { label: "Go to Overview", go: { area: "overview" } },
          { label: "Go to Investigations", go: { area: "investigations" } },
        ],
      },
      {
        id: "read-situation",
        title: "Pick an investigation back up",
        summary:
          "Situation opens with the recorded working record: what is suspected, what is outstanding, what was seen, and what nobody has read yet.",
        keywords: [
          "situation",
          "briefing",
          "hypothesis",
          "next action",
          "observation",
          "handover",
          "returning",
          "context",
          "unverified",
        ],
        what:
          "Below the recorded context fields, Situation shows \"Where the investigation stands\": working hypotheses, next actions, and latest observations as people wrote them, plus imported analysis that no person has corroborated or contradicted yet. Each entry carries its author and time, a bounded excerpt with the complete text one disclosure away, and a control that opens the exact record where it lives. A closing line restates how much evidence the investigation has registered and links to the evidence board.",
        when:
          "Read this when you return to an investigation someone else moved on, or when you are handing one over and want to see what a colleague will read first.",
        steps: [
          "Open the investigation — Situation opens first.",
          "Read Where the investigation stands to see the substance of the record rather than a count of it.",
          "Expand any entry whose excerpt is truncated to read it in full.",
          "Select \"Open where this was recorded\" on an entry to jump to that exact record on Capture, or \"Open to record a human judgment\" to corroborate or contradict an imported run.",
        ],
        recorded:
          "The briefing re-presents contributions and imported runs this investigation already recorded; it reads nothing the Capture stage does not already hold and writes nothing of its own. Entries removed from the working record are excluded, while the audit history that names them is untouched.",
        limits:
          "A working hypothesis is a possibility recorded for testing, never an established cause, and the briefing says so. Imported and AI-assisted output is kept in its own group and is never labeled human-authored. Each group shows the most recent few entries and says how many more are recorded in Capture. Evidence is restated as a count of what was registered; open the evidence board to read the items themselves.",
        actions: [{ label: "Open the Situation stage", go: { stage: "situation" } }],
      },
      {
        id: "signing-in",
        title: "Sign in, roles, and what you can do",
        summary:
          "Sessions come from the workspace server; a directory group must map to a workspace role before the workspace opens.",
        keywords: ["login", "password", "roles", "permissions", "viewer", "contributor", "case-lead", "admin", "ldap", "fixture", "demo"],
        what:
          "Signing in sends your username and password to the workspace server, which checks them against its configured identity source and maps your directory groups to one of four roles: viewer, contributor, case-lead, or admin. Each role is a default bundle of capabilities; a local grant can add a capability without changing the role. Viewers can read investigations they can access. Contributors can also add notes, upload evidence, and import external runs. Case leads can additionally freeze snapshots, launch AI lanes, accept decisions, manage sources, change case status, and create exports. The Administration page is visible only with the admin:users capability (the admin role includes it; a local grant can add it to another role). Suspended, disabled, and historical/imported identities cannot sign in, and an existing session for those accounts is treated as signed out.",
        when:
          "Use this when sign-in fails, or when a button you expected is missing — most missing controls are role-gated, and the page usually says which role is required.",
        steps: [
          "Enter your username and password and select Sign in.",
          "If sign-in fails, read the message: wrong credentials, a missing role mapping, a suspended or historical identity, or rate limiting each say so explicitly.",
          "If your credentials are accepted but no role is mapped, an administrator has to grant a role before the workspace opens.",
          "Check your roles any time from the account menu in the top bar. Open My profile from that menu to see your current display name, directory ownership, and local contact details.",
        ],
        recorded:
          "The server audits sign-ins and sign-outs. The browser keeps only an HttpOnly session cookie — this form never stores your password.",
        limits:
          "In sample-data and demo builds, sign-in uses a built-in fixture account (demo/demo) — that is not your organization's directory. Production deployments authenticate against the server's configured identity source (an LDAP directory by default, or a local user file for private setups); this web app cannot tell you which one is configured.",
        actions: [{ label: "Go to My profile", go: { area: "profile" } }],
      },
      {
        id: "start-investigation",
        title: "Start and find investigations",
        summary:
          "Contributors and leads can open a new investigation; everyone can search and filter the recorded list.",
        keywords: [
          "create",
          "new case",
          "search cases",
          "filter",
          "status",
          "severity",
          "title",
          "product",
          "version",
          "build",
          "component",
          "environment",
          "organization",
          "customer",
          "tags",
        ],
        what:
          "An investigation is the unit of work: a titled case with a durable Situation, recorded status (open, monitoring, resolved, or archived), severity, participants, structured software or product context, and timeline. Situation records the problem statement, affected people or systems, impact, scope, and open questions without treating missing context as fact. The structured context fields are software or product, version, build, component, environment, and organization, customer, or entity. The Investigations area lists every case visible to your account, with search over title, ID, creator, participants, and these context fields, plus a status filter.",
        when:
          "Start an investigation when your team begins working a problem it wants a durable, attributable record of.",
        steps: [
          "Select Start investigation in the top bar (or use the form under the investigation list).",
          "Enter a title and the Situation context you know now: the observed problem, affected people or systems, impact, scope, one open question per line, and any structured software or product context. Blank fields remain visibly not recorded.",
          "Use the structured context suggestions when one matches, or enter a new value when it does not. The display value you enter is kept as written; flexible tags are a later extension.",
          "Create the investigation — it opens on Situation, where an authorized member can refine those fields as the investigation develops.",
          "To find existing work, use the list's search field or the status filter.",
        ],
        recorded:
          "Creation records who opened the case and when. Situation edits and status changes are recorded. Contributors, case leads, and admins can edit Situation on a case they can access; only a case lead can change status.",
        limits:
          "Creating requires the investigation:write capability (the contributor, case-lead, and admin roles include it; a local grant can add it to a viewer). Severity starts at medium; this build does not offer a severity picker at creation. Empty Situation fields mean not recorded — they are never filled from model guesses. Suggestions are existing recorded values, not a controlled vocabulary.",
        actions: [{ label: "Go to Investigations", go: { area: "investigations" } }],
      },
    ],
  },
  {
    id: "capture",
    title: "Capture & provenance",
    articles: [
      {
        id: "record-contributions",
        title: "Record notes, hypotheses, and actions",
        summary:
          "Add human-authored entries to the case timeline, each attributed to you and classified for sharing before you save.",
        keywords: ["note", "hypothesis", "action", "message", "timeline", "contribution", "privacy class", "owner only"],
        what:
          "The Capture stage takes human-authored entries: messages, notes, hypotheses, and actions. Each entry carries a privacy class — owner_only (private to the case) or share_safe (eligible for share-safe export) — chosen under Sharing options before you save.",
        when:
          "Use it whenever you observe something worth keeping: a finding, a theory to test, or a step someone took.",
        steps: [
          "Open the investigation and go to the Capture stage.",
          "Choose the entry kind: message, note, hypothesis, or action.",
          "Write the body, open Sharing options if the entry may be exported later, and save.",
        ],
        recorded:
          "Each contribution records its author, timestamp, kind, privacy class, and a content hash, and it keeps a revision lineage. Timeline chips mark entries as human-authored or imported output — never guessed.",
        limits:
          "Writing requires the contributor role or above. A hypothesis you record starts as proposed; this build's web UI has no control to mark it supported or contradicted, so those board buckets change only through other recorded activity.",
        actions: [{ label: "Open the Capture stage", go: { stage: "capture" } }],
      },
      {
        id: "import-external-run",
        title: "Import output from an outside tool",
        summary:
          "Paste a run from another AI tool with its provenance stated honestly — unknown stays unknown, and a human later corroborates or contradicts it.",
        keywords: ["imported run", "paste", "external", "operator", "provenance", "corroborate", "contradict", "visibility", "snapshot binding"],
        what:
          "An imported run is output pasted from a tool outside ContextDesk. You attribute it to a registered source, name the operator who ran it, and state what evidence the tool could see — \"unknown\" is a permanent, valid answer. Imported runs land on the timeline as unverified until a person records a judgment that links supporting or contradicting case material.",
        when:
          "Use it when a teammate ran something elsewhere (another assistant, a vendor tool) and the team needs that output in the case record without pretending ContextDesk produced or verified it.",
        steps: [
          "On the Capture stage, open the pasted-external-output form.",
          "Paste the output (and the prompt, if you have it), pick the source, and enter the operator's name and ID.",
          "Confirm you redacted secrets before saving, and state the evidence visibility — leave it unknown rather than guessing.",
          "Optionally record a package snapshot identity under Provenance details if the run came from an exported ContextDesk package.",
          "Later, record a human judgment: corroborated or contradicted, linked to a specific evidence or contribution ID.",
        ],
        recorded:
          "The import records importer and operator identities, a content hash of the output (and prompt when given), the stated evidence visibility, and prompt completeness — an output-only import can never claim an exact prompt.",
        limits:
          "A package snapshot identity is a content-addressed reference, not a signature or a verification. Importing never runs the outside tool, and an unverified banner stays until a human records a judgment.",
        actions: [{ label: "Open the Capture stage", go: { stage: "capture" } }],
      },
      {
        id: "upload-evidence",
        title: "Upload evidence files",
        summary:
          "Register files on the evidence board with a summary, kind, and privacy class; each upload is hashed on arrival.",
        keywords: ["evidence", "file", "upload", "artifact", "log", "email", "attachment", "hash", "verification"],
        what:
          "Single-file uploads still live on the Analyze stage's evidence board. Each upload takes a file (1 MB or smaller), a required summary, an artifact kind (log, email, attachment, or file_server_ref), and a privacy class. The board lists every artifact with its kind, verification status, uploader, and content hash. ZIP archives and directories belong on Capture — see Add logs from files, ZIP, or a directory.",
        when:
          "Upload a single sanitized file before freezing a snapshot, so AI lanes and human review can cite exactly what the team collected.",
        steps: [
          "Open the investigation's Analyze stage and find Upload evidence on the evidence board.",
          "Choose the file, write a short summary, and pick the artifact kind and privacy class.",
          "Upload. Case leads can tick \"Freeze a snapshot with this upload\" to freeze in the same step.",
        ],
        recorded:
          "Each artifact records its uploader, kind, privacy class, and content hash. A verification status is shown per artifact — \"verification unknown\" is displayed honestly when none is recorded.",
        limits:
          "Files larger than 1 MB are rejected. Upload sanitized content only — the privacy class controls export eligibility, but it does not scrub the file for you.",
        actions: [{ label: "Open the Analyze stage", go: { stage: "analyze" } }],
      },
      {
        id: "corpus-intake",
        title: "Add logs from files, ZIP, or a directory",
        summary:
          "Intake stays on the selected investigation: preview a file batch, a ZIP, or a browser directory, then commit bounded evidence that freeze and triage can select.",
        keywords: [
          "zip",
          "directory",
          "folder",
          "corpus",
          "intake",
          "logs",
          "batch",
          "preview",
          "redaction",
          "privacy",
          "size limit",
          "triage",
        ],
        what:
          "The Capture stage's Logs and files panel adds evidence to the open investigation only. You can choose individual files, a ZIP archive, or a directory (the browser supplies relative paths). Preview lists accepted and rejected files before anything is stored. Commit stages accepted bytes, then records evidence, provenance, timeline, batch, and success audit as one operation; a failure rolls all of them back. The global Sources catalog stays for reusable connector definitions — ordinary one-investigation uploads do not go through it.",
        when:
          "Use it when an operator has a folder or ZIP of logs for one investigation and needs them on the evidence board without a separate conversion step.",
        steps: [
          "Open the investigation's Capture stage and find Logs and files for this investigation.",
          "Choose Files, ZIP archive, or Directory, set a source label and privacy class, and select the payload.",
          "Preview. Read the accepted and rejected lists — rejected bytes are never shown as text.",
          "Commit. Retry after a disconnect reuses the same idempotency key and will not duplicate committed evidence.",
          "On Analyze, inspect logs in the expandable viewer, freeze selected evidence, and run the existing qwen-3.6-27b, gpt-oss-120b, and ministral comparison lanes against that snapshot.",
        ],
        recorded:
          "Each accepted file gets its own evidence identity and records relative path, media type, digest, byte length, privacy class, uploader identity, import time, source attribution, and intake batch id. Equal digests reuse the same content-addressed bytes without collapsing those distinct evidence records. Deep links exist for the batch on Capture and each evidence item on Analyze.",
        limits:
          `${CORPUS_CAPACITY_COPY} These are hard resource bounds, not a promise that every member is accepted. Building the investigation's log corpus uses the same file-count, per-file, and expanded-byte bounds and rejects overflow instead of silently dropping files. ZIP extraction rejects absolute paths, traversal, drive/UNC paths, symlinks/hardlinks, device entries, duplicate normalized paths, nested archives, encrypted archives, ZIP64, and malformed central-directory metadata. Allowlisted extensions are .log, .txt, .json, .jsonl, .ndjson, .csv, .xml, .eml, and .md; common rotated log names such as service.log.1 and service.log-2026-08-25 are also recognized. Declared media must match; JSON documents and every non-empty JSON Lines record must parse. Private line-oriented text with sparse legacy encoding bytes keeps its original bytes and digest while text views and log analysis replace unreadable bytes explicitly; dense invalid data and binary content are rejected. Non-UTF-8 content cannot enter through share_safe intake. share_safe accepts plain text, logs, CSV, Markdown, valid JSON, and valid JSON Lines only, and scans structured JSON plus path and source metadata before commit; XML and email require owner_only. Marking share_safe does not scrub the file. The global source catalog is not the intake path for these uploads.`,
        actions: [{ label: "Open the Capture stage", go: { stage: "capture" } }],
      },
    ],
  },
  {
    id: "analyze",
    title: "Analyze & triage runs",
    articles: [
      {
        id: "freeze-snapshot",
        title: "Freeze an evidence snapshot",
        summary:
          "A case lead freezes a fingerprinted, ordered set of evidence — the exact material a later run is allowed to see.",
        keywords: ["snapshot", "freeze", "fingerprint", "lineage", "frozen", "evidence set"],
        what:
          "An evidence snapshot is an immutable, ordered selection of evidence items with a fingerprint — a content hash over the parent snapshot, the sorted evidence (including each item's own hash), visibility, and protocol version. Snapshots form a lineage (S0, S1, …), and the case board can be viewed as of any snapshot.",
        when:
          "Freeze a snapshot when the evidence set is worth pinning: before launching AI lanes, or before comparing anything that must be judged against the same material.",
        steps: [
          "On the Analyze stage, tick the evidence items to include on the evidence board.",
          "Select Freeze selected evidence — this requires the case-lead role.",
          "The new snapshot appears in the lineage with its item count, creator, and fingerprint.",
        ],
        recorded:
          "Each snapshot records who froze it, when, its parent, each item's content hash and verification status, and the derived fingerprint. Loading a snapshot re-derives the fingerprint and rejects a mismatch.",
        limits:
          "Runs bound to a snapshot never silently widen to newer evidence — new evidence means freezing a new snapshot. The fingerprint is a content hash, not a cryptographic signature.",
        actions: [{ label: "Open the Analyze stage", go: { stage: "analyze" } }],
      },
      {
        id: "read-workstreams",
        title: "Read a workstream",
        summary:
          "Each recorded workstream has its own address: purpose, owner, frozen inputs, findings, cited evidence, unknowns, and a timestamped history.",
        keywords: [
          "workstream",
          "workstreams",
          "lane",
          "share",
          "link",
          "deep link",
          "history",
          "evidence",
          "unknowns",
          "technical details",
        ],
        what:
          "A workstream is one line of investigation against a frozen set of evidence — not a model button. Its record states the exact question it was asked, whether it was AI-assisted, human, programmatic, imported, or host-run, who requested it, which frozen evidence set it saw and whether the host proved that binding, what it reported, which evidence it cited, what it left unknown, and what happened in what order. Run, lane, snapshot, request, and task identifiers, fingerprints, and hashes sit under Technical details.",
        when:
          "Open a workstream when you need to judge one attempt on its own terms, or when you want to hand another engineer a link to exactly that record.",
        steps: [
          "On the Analyze stage, find the workstream under the strategy and question it belongs to.",
          "Select it — the evidence board and run launcher step aside so the workstream is the page.",
          "Read the cited evidence in place; expand a long log or stack trace for the complete text, and copy it if you need it elsewhere.",
          "Select \"Copy link to this workstream\" to share that exact record, or copy the address from the browser; reload, Back, and Forward all return to it.",
        ],
        recorded:
          "The record restates what the run already stored: timestamps, the authenticated requester, per-lane status, cited evidence with its registered summary and integrity state, recorded unknowns, and rerun lineage. Identifiers are collapsed for reading, never dropped — machine exports carry them unchanged.",
        limits:
          "An empty unknown list means nothing was recorded as unknown, not that nothing is unknown. AI-assisted output is analysis, never a human finding, and agreement between workstreams is not proof of correctness. A citation that no longer resolves is marked unresolved rather than reconstructed, and an address naming a workstream this investigation does not have fails closed. A copied address is not an access grant: whoever opens it is authorized again at that moment, and sees nothing they could not already read.",
        actions: [{ label: "Open the Analyze stage", go: { stage: "analyze" } }],
      },
      {
        id: "run-lanes",
        title: "Run AI lanes against a snapshot",
        summary:
          "A case lead launches a triage run: two or more model lanes bound to one frozen snapshot, synthetic or through the host's gateway.",
        keywords: ["triage run", "lane", "model", "synthetic", "gateway", "launch", "profile", "runner", "job", "concurrency"],
        what:
          "A triage run binds two to sixteen candidate lanes — each an alias, model identity, role, and (for gateway runs) a host profile — to exactly one frozen snapshot. Two execution modes exist in this build: Synthetic / offline (a deterministic, provider-free stand-in run on the server) and Configured gateway (the host bridge executes real lanes; it owns provider calls and credentials, and each lane sends only a profile ID). Lane statuses move through queued, running, and a settled outcome: completed, partial, failed, timed out, or cancelled.",
        when:
          "Run lanes after freezing a snapshot, when the team wants structured, comparable model output over exactly that evidence.",
        steps: [
          "On the Analyze stage, open the AI lane runner and pick a frozen snapshot.",
          "Choose the execution mode. Gateway appears only when the host has a runner configured.",
          "Pick model lanes — for gateway lanes, select each lane's host profile — and set the question and strategy.",
          "Launch, and watch lanes settle independently; a finished run can be handed to the Experiment Lab for review.",
        ],
        recorded:
          "Each run records its snapshot binding and fingerprint, request fingerprint, who requested it, per-lane model and profile identity, per-lane output hashes and cited evidence, and timestamps. Usage and cost are always recorded as unknown — the workspace never invents them.",
        limits:
          "Launching requires the case-lead role. Synthetic lanes are placeholders and say so — they make no live-model claims. Gateway availability depends on host configuration this app can only report, not change. Agreement between lanes is not proof of correctness, and the run panel says exactly that.",
        actions: [{ label: "Open the Analyze stage", go: { stage: "analyze" } }],
      },
      {
        id: "case-board",
        title: "Read the case board",
        summary:
          "Five buckets restate what the recorded case currently supports: Known, Unknown, Agreed, Disputed, and Newly concluded.",
        keywords: ["board", "known", "unknown", "agreed", "disputed", "concluded", "buckets", "supports"],
        what:
          "The case board is a pure projection of recorded material. Known holds findings directly supported by verified evidence or supported hypotheses. Unknown holds unverified evidence and open hypotheses. Agreed holds independent hypotheses citing the same evidence. Disputed holds contradicted hypotheses awaiting human adjudication. Newly concluded holds human-accepted decisions from the case's experiment reviews.",
        when:
          "Read the board to see where the case stands on record — especially before proposing a decision.",
        steps: [
          "Open the Analyze stage; the board sits below the evidence and snapshot panels.",
          "Select a snapshot in the lineage to view the board as of that snapshot.",
          "Follow each finding's evidence references back to the material it cites.",
        ],
        recorded:
          "Each finding lists its statement, agreement and confidence labels, and the evidence and contribution references it rests on. Accepted decisions carry an explicit tag.",
        limits:
          "The board derives only from recorded material: an empty Unknown list is not proof there are no unknowns, and Agreed means shared citations — agreement is not correctness.",
        actions: [{ label: "Open the Analyze stage", go: { stage: "analyze" } }],
      },
    ],
  },
  {
    id: "compare",
    title: "Compare models & evidence fairness",
    articles: [
      {
        id: "compare-lanes",
        title: "Compare lanes side by side",
        summary:
          "The Experiment Lab lays out what agrees, what differs, and what stays unknown across a run's lanes — differences are leads, not a ranking.",
        keywords: ["experiment lab", "comparison", "divergence", "review queue", "candidates", "cross-examination", "trace"],
        what:
          "The Compare stage hosts the Experiment Lab view of an experiment record — usually handed off from a finished triage run. It shows candidate scorecards, an evidence cross-examination matrix (which lanes cited which evidence, and in what role), strategy comparison with trace events, and a review queue: a deterministic list of items worth a human look, in a fixed order.",
        when:
          "Use it after lanes settle, when the team needs to see where models converged, where they split, and what no lane addressed.",
        steps: [
          "Open the investigation's Compare stage.",
          "Read the at-a-glance cards: what agrees, what differs, what stays unknown, and what a human decided.",
          "Work the review queue top to bottom — the same record always produces the same queue.",
          "Use the evidence matrix to spot single-lane citations, role conflicts, and anchors no lane cites.",
        ],
        recorded:
          "The record keeps each candidate's status, cited evidence, divergences, explicit unknowns, human reviews, and any decision or benchmark linked to it.",
        limits:
          "Nothing here is scored or ranked: differences are leads to investigate, textual similarity is not a winner, and an empty review queue does not certify correctness. Latency, usage, and cost show as unknown unless actually observed.",
        actions: [{ label: "Open the Compare stage", go: { stage: "compare" } }],
      },
      {
        id: "snapshot-fairness",
        title: "Same-snapshot fairness",
        summary:
          "Runs are comparable only when every lane provably saw identical evidence — the cockpit reports that with positive evidence or says it cannot.",
        keywords: ["fairness", "same snapshot", "cockpit", "controlled", "mismatch", "pending", "comparable"],
        what:
          "The evidence snapshot cockpit (with the lane runner on the Analyze stage) adjudicates whether selected runs form a controlled comparison. \"Controlled\" requires positive evidence: every run bound to the same snapshot, fingerprints present and identical, and every snapshot's fairness class established as same-snapshot. Anything less is reported as single, mismatch, or pending — with the reason spelled out.",
        when:
          "Check fairness before drawing conclusions from a side-by-side reading of runs, and before presenting a comparison to others.",
        steps: [
          "On the Analyze stage, select the finished runs you want to compare.",
          "Read the cockpit verdict and its reason.",
          "If the verdict is mismatch or pending, fix the setup — same snapshot, settled lanes — rather than comparing anyway.",
        ],
        recorded:
          "The cockpit displays each snapshot's full fingerprint, evidence and verification counts, fairness class, visibility, creator, and freeze time.",
        limits:
          "Identical evidence makes runs comparable — it does not make any lane's answer correct, and matching answers are not proof either. A snapshot containing any unhashed item has an unknown fairness class and cannot anchor a controlled comparison.",
        actions: [{ label: "Open the Analyze stage", go: { stage: "analyze" } }],
      },
      {
        id: "helpfulness-gold",
        title: "Score helpfulness and gold alignment",
        summary:
          "Humans score responses on four dimensions, and a promoted gold reference is a human benchmark — never an infallible truth claim.",
        keywords: ["helpfulness", "gold", "benchmark", "score", "alignment", "review", "rationale"],
        what:
          "In the Experiment Lab, contributors record helpfulness observations: 0–3 scores on evidence support, actionability, uncertainty calibration, and unsafe or unsupported claims, with a rationale and the reviewer's name. Separately, a case lead can promote an accepted decision to a gold reference; lanes are then reported as aligned, partially aligned, divergent, or unscored against it.",
        when:
          "Score helpfulness while reviewing lanes so later readers see human judgment next to model output. Promote gold when the team wants a stable human benchmark for future runs.",
        steps: [
          "Open the Compare stage and pick a candidate response.",
          "Record scores on the four dimensions with a short rationale.",
          "A case lead can promote an accepted decision to gold; alignment then appears per lane.",
        ],
        recorded:
          "Each observation records the reviewer, scores, and rationale. Gold promotion records the promoting lead, version lineage, the source decision and revision, and evidence anchors.",
        limits:
          "Helpfulness describes response usefulness — it makes no live-provider claims. Gold is a human benchmark decision, and gold alignment is scored separately from helpfulness; neither is a correctness verdict.",
        actions: [{ label: "Open the Compare stage", go: { stage: "compare" } }],
      },
    ],
  },
  {
    id: "decide",
    title: "Decide & share-safe export",
    articles: [
      {
        id: "accept-decision",
        title: "Propose and accept a decision",
        summary:
          "Contributors propose; a case lead accepts. The server's revision guard rejects stale acceptances, and an accepted decision is immutable.",
        keywords: ["decision", "accept", "propose", "rationale", "revision", "status", "resolve", "human call"],
        what:
          "Decisions are human calls — analysis informs them, it never makes them. Anyone with write access can propose a decision with text, a rationale, and evidence references. Only a case lead can accept the latest proposal, and acceptance is guarded by an expected revision: a stale acceptance is rejected, not merged. Once accepted, a decision cannot be edited; it appears in the case board's Newly concluded bucket.",
        when:
          "Use it when the team has weighed the compared lanes and the evidence and is ready to conclude something on the record.",
        steps: [
          "Review the lanes in Compare first; the Decide stage links back to them.",
          "Propose a decision with its rationale and the evidence it rests on.",
          "A case lead accepts the proposal; the decision history shows every revision and author.",
          "A case lead updates the case status (open, monitoring, resolved, or archived) to match.",
        ],
        recorded:
          "Every decision revision records its author, timestamp, text, rationale, and evidence references. Acceptance writes a new revision rather than overwriting history.",
        limits:
          "Accepting and status changes require the case-lead role. An already-accepted decision is immutable — a new conclusion means a new proposal.",
        actions: [{ label: "Open the Decide stage", go: { stage: "decide" } }],
      },
      {
        id: "share-safe-export",
        title: "Export a brief or selected-evidence package share-safely",
        summary:
          "Exports are read-only projections. The share_safe variant is default-deny for private material and must pass a privacy scan before anything leaves the case.",
        keywords: ["export", "share safe", "share-safe", "brief", "package", "privacy scan", "redaction", "omissions", "owner only"],
        what:
          "The Decide stage's export tools produce two read-only projections: a triage brief and a selected-evidence prompt package, each in an owner_only or share_safe variant. The package contains only the evidence you explicitly select for another analysis tool; it is not a full case backup. share_safe excludes the content of owner-only items, replaces identities with neutral labels, carries digests instead of raw timeline payloads, and is blocked entirely if a privacy scan finds credentials, internal hostnames, or raw private evidence. Imported external runs are excluded from packages by default. The Experiment Lab has its own share-safe review export that replaces every identifier with an alias and records five hard-coded omissions: no model labels, no participant identities, no free text, no private content, no correlatable metadata.",
        when:
          "Export when findings need to travel — a summary for stakeholders, or a package another tool will consume — instead of copying raw case data out of the workspace.",
        steps: [
          "On the Decide stage, open Case export tools.",
          "Choose the variant: owner_only needs write access; share_safe needs the case-lead role.",
          "For a package, tick the evidence to include; excluded-by-default items cannot be selected.",
          "Export. If the privacy scan blocks it, nothing left the case — the findings list shows why.",
        ],
        recorded:
          "Each export reports a snapshot identity: the content hash of its manifest, so identical inputs reproduce the same identity. Export never edits the case.",
        limits:
          "The snapshot identity is a content hash, not a cryptographic signature — exports are not signed. share_safe is deny-by-default, and a blocked export sends nothing. Neither current export can reconstruct the complete investigation on another installation.",
        actions: [{ label: "Open the Decide stage", go: { stage: "decide" } }],
      },
      {
        id: "move-or-restore-investigation",
        title: "Move or restore a portable investigation",
        summary:
          "A portable archive is different from the current brief and selected-evidence package. Only fields represented and supported exactly can be restored after a dry-run check and typed confirmation.",
        keywords: ["move", "restore", "backup", "portable", "archive", "import", "different installation", "migration"],
        what:
          "Moving an investigation requires more than a readable summary. This archive carries the supported Situation, contributions, historical attribution, evidence inventory and bytes, frozen snapshots, triage runs, comparisons, decisions, and benchmark history. Source memberships, role authority, audit references, discussions, and opaque imported-run state are not exported; an archive that represents unsupported exact-apply state is blocked. Historical people and roles remain attribution only and never grant destination access.",
        when:
          "Read this when you need disaster recovery, migration to another installation, or a case that another War Room can reconstruct and continue.",
        steps: [
          "Do not use the triage brief or selected-evidence prompt package as a backup; both are intentionally partial projections.",
          "Download the portable investigation archive from Decide, then on the destination War Room run the dry-run check.",
          "Restore only when the check reports an exact reconstruction. Type RESTORE as a separate confirmation. Metadata-only, blocked, omitted, private, or redacted required content cannot be applied.",
          "After restore, open the returned investigation link and verify the reconstructed Situation, evidence, snapshot lineage, decisions, and historical attribution before continuing work.",
        ],
        recorded:
          "A successful restore writes one investigation with destination identifiers, source-installation provenance, evidence bytes, and an apply audit in one coordinated operation. Replay is scoped to the applying actor. Historical people are not granted membership, roles, or capabilities.",
        limits:
          "Restore applies only an exact reconstruction. Archive Ed25519 metadata is recorded, not verified. Interaction traces, discussions, audit references, source membership, and opaque imported-run details remain unsupported. Evidence bytes are staged and rolled back with failed metadata writes. PostgreSQL mode coordinates replicas transactionally; memory and SQLite modes are supported only as single-server-instance coordination, and the dry-run screen reports whether confirmation survives restart.",
        actions: [{ label: "Open the Decide stage", go: { stage: "decide" } }],
      },
    ],
  },
  {
    id: "teams",
    title: "Investigation Teams & qualification",
    articles: [
      {
        id: "participants-roles",
        title: "People on an investigation",
        summary:
          "Cases record participants; workspace-wide permissions come from directory-mapped roles. This build has no separate team entity.",
        keywords: ["participants", "team", "members", "people", "who", "case membership"],
        what:
          "Each investigation records its participants, shown on the case card and the Situation page. Case membership decides which investigations you can open; it does not grant capabilities. Workspace permissions come from your mapped role plus any local capability grants, resolved on every request from the current profile status.",
        when:
          "Check the Situation page when you need to know who is recorded on a case, and the account menu for your own roles.",
        steps: [
          "Open the investigation's Situation stage to see recorded participants.",
          "Open the account menu in the top bar to see your own username and roles.",
        ],
        recorded:
          "Participant usernames and the case creator are recorded per case and are searchable from the investigation list.",
        limits:
          "There is no separate \"team\" object in this build, and the web UI has no control for adding or removing participants — participation is recorded by the server as work happens. Presence (who is active right now) is a different, ephemeral signal covered under Collaboration & presence.",
      },
      {
        id: "qualification",
        title: "Lane qualification and host profiles",
        summary:
          "Qualification is an operator-run harness with honest step outcomes — passed, failed, skipped, or partial — and it has no screen in this web app.",
        keywords: ["qualification", "qualify", "host profile", "gateway", "configured", "skipped", "partial", "harness", "operator"],
        what:
          "A host profile is a credential-free identifier — an ID, label, and provider name — for a provider configuration the host owns. The workspace serves the profile catalog to the lane launcher; endpoints, credentials, and raw provider traffic never enter the browser. Qualification is how an operator proves lane execution works on a host: a command-line harness runs scripted checks and records each step as passed, failed, skipped, or partial. Live qualification additionally records, per profile, whether it was configured and whether it actually ran — a profile that did not run is recorded as skipped with an explicit reason (for example, live disabled or bridge not configured), never guessed, and an overall verdict can be inconclusive.",
        when:
          "Read this when the lane launcher reports the gateway unavailable, or when you need to know how much to trust a host's live-lane setup.",
        steps: [
          "In the lane launcher, check the execution-mode selector: gateway is disabled when the host has no runner configured.",
          "Ask your operator for the host's qualification report — it is produced by a command-line harness, not by this app.",
          "Treat unqualified or partially qualified hosts accordingly: synthetic mode always works and says what it is.",
        ],
        recorded:
          "Qualification reports carry per-step outcomes, per-profile configured/ran/skipped states with reasons, and mandatory caveats — including that agreement is not correctness and that live results are never fabricated.",
        limits:
          "This web app shows no qualification status — stale, partial, or failed qualification is invisible here; only gateway availability and the profile count surface in the launcher. Team-level qualification policies are not part of this build.",
      },
    ],
  },
  {
    id: "entities",
    title: "Entities",
    articles: [
      {
        id: "entity-registry",
        title: "Who and what an investigation is about",
        summary:
          "Reusable labels name the organizations, customers, people, services, and systems investigations concern, so the same party is findable years later.",
        keywords: [
          "entity",
          "entities",
          "organization",
          "customer",
          "person",
          "service",
          "system",
          "stakeholder",
          "involved",
          "party",
          "affected",
        ],
        what:
          "The Entities area stores reusable labels for what investigations are about: an organization, a customer, a person, a service, a system, or something that fits none of those. It is a different list from Attribution next door. Attribution answers where a piece of information came from; Entities answers who or what the work concerns. A vendor is often both, and stays two separate rows. Neither area stores logs, files, email, chat, or notes — those stay in the investigation where they were captured.",
        when:
          "Name the entities an investigation involves when you open it, or add them later. Use the entity filter on the investigation list to find every investigation that concerned the same party.",
        steps: [
          "Open Entities from the primary navigation to add or review a label.",
          "In an investigation’s Situation stage, add the entities it involves and say how each one is involved.",
          "End an involvement when it stops being true. The record keeps showing that it was once involved.",
        ],
        recorded:
          "An involvement records the label and kind the entity had at the moment it was linked. Renaming or retiring the entity later never rewrites what an older investigation said; the current name is shown beside the recorded one so the difference is visible.",
        limits:
          "A label is not an account and creates no connection to the named party. A name stays inside the tool unless someone marks it as safe to leave in a share-safe export; otherwise an export shows the kind and a stable stand-in instead. Retiring needs the case-lead role.",
        actions: [{ label: "Go to Entities", go: { area: "entities" } }],
      },
      {
        id: "occurred-at",
        title: "Work that happened before it was written down",
        summary:
          "An investigation records when something happened separately from when it was entered, and never guesses a time zone that was not recorded.",
        keywords: [
          "occurred",
          "backfill",
          "historical",
          "old",
          "date",
          "when",
          "time zone",
          "timezone",
          "recorded",
        ],
        what:
          "Every investigation carries two dates. When it happened is what you type, and may be a year, a month, a date, or a full timestamp. When it was recorded here is set by the server and never changes. Backfilling an old investigation moves only the first one, so nothing in the audit history has to be rewritten to describe work that predates this tool.",
        when:
          "Use it whenever you open an investigation about something that already happened, or when you learn the date of one that was recorded without it.",
        steps: [
          "Enter a date in the creation form, or use “Record when it happened” in the Situation stage later.",
          "Type only what you know: 2024, 2024-11, or 2024-11-04 are all complete answers.",
          "Add a time zone only if you actually know it.",
        ],
        recorded:
          "A date typed without a time zone is stored exactly as typed and shown that way, labelled as not recorded rather than read as UTC or as your local time. Changing it appends a timeline entry; it never edits the earlier record.",
        limits:
          "A date in the future is refused, as is a date that does not exist. This area sets no reminders and drives no scheduling.",
        actions: [{ label: "Go to Investigations", go: { area: "investigations" } }],
      },
      {
        id: "cross-investigation-references",
        title: "Citing another investigation",
        summary:
          "A reference links to earlier work and says why. It copies nothing, changes nothing, and does not become evidence.",
        keywords: [
          "reference",
          "cite",
          "citation",
          "link",
          "related",
          "prior",
          "duplicate",
          "cross-investigation",
        ],
        what:
          "A reference points from this investigation to another one, or to one record inside it, together with the reason it is relevant. The link is the same address the activity feed uses, so it lands on a visible record.",
        when:
          "Cite an earlier investigation when this one repeats it, depends on it, or was caused by the same thing.",
        steps: [
          "Open the Situation stage and choose an investigation under “Other investigations this one cites”.",
          "Say what connects the two.",
          "Withdraw a reference that stops being relevant. The record still shows it was made.",
        ],
        recorded:
          "A citation records the cited investigation’s title at the time it was made, who made it, and when. Nothing is written into the cited investigation.",
        limits:
          "You can only cite an investigation you can read, and reading a citation grants nothing: someone without access sees that a citation exists and where it points, and does not see its title. A citation never becomes supporting evidence for a hypothesis on its own.",
        actions: [{ label: "Go to Investigations", go: { area: "investigations" } }],
      },
      {
        id: "human-resolution",
        title: "Resolving without a model run",
        summary:
          "People can conclude an investigation by reading the record. What is required is the reason, not a comparison.",
        keywords: [
          "resolve",
          "resolved",
          "decision",
          "conclusion",
          "rationale",
          "unknowns",
          "manual",
          "human",
          "exception",
          "duplicate",
        ],
        what:
          "Setting an investigation to resolved records a conclusion, so it asks for one. Reasoning it out from the notes and evidence is a first-class answer and needs no experiment. Closing a case without answering its question — a duplicate, withdrawn, or overtaken by events — is recorded explicitly as an exception rather than left as an unexplained status change.",
        when:
          "Use it when the work is finished, however it was finished.",
        steps: [
          "In the Decide stage, choose resolved and update the status.",
          "Say how the conclusion was reached, why, and what is still unknown.",
          "Save. The conclusion and the status are recorded together.",
        ],
        recorded:
          "A resolution records the basis, who wrote it, the reasoning, and the open unknowns. Reopening an investigation withdraws the conclusion without deleting it, and resolving again needs a fresh one.",
        limits:
          "Resolving needs the case-lead role. The reasoning stays inside the tool: a share-safe export carries the basis and the number of open unknowns, not the text.",
        actions: [{ label: "Go to Investigations", go: { area: "investigations" } }],
      },
    ],
  },
  {
    id: "sources",
    title: "Attribution",
    articles: [
      {
        id: "source-library",
        title: "Who and what supplied the information",
        summary:
          "Reusable labels show which person or tool supplied material. The material itself stays inside its investigation.",
        keywords: ["source", "catalog", "library", "register", "retire", "attribution", "external tool", "unknown"],
        what:
          "The Attribution area stores reusable labels for the people and tools that supplied information. It does not store the logs, files, email, chat, or notes themselves; those stay in the investigation where they were captured. Labels can identify a person, an external tool, an internal system, ContextDesk, or an honestly unknown origin. It is a separate list from Entities, which names who or what an investigation is about rather than where its information came from.",
        when:
          "Add a label when an investigation needs to credit a person or tool that is not listed yet. Browse the library to understand where recorded material came from.",
        steps: [
          "Open Attribution from the primary navigation.",
          "Search or browse the people and tools that can be credited.",
          "Case leads can add a label or retire one. Retired labels remain attached to older investigations.",
        ],
        recorded:
          "A source records who registered it and when. Retiring hides it from new intake — every past attribution keeps it.",
        limits:
          "Registering and retiring require the case-lead role. A source stores no credentials, creates no connection or automatic access, and naming one never makes material correct.",
        actions: [{ label: "Go to Attribution", go: { area: "sources" } }],
      },
    ],
  },
  {
    id: "collaboration",
    title: "Collaboration & presence",
    articles: [
      {
        id: "presence",
        title: "See who is working the case",
        summary:
          "Presence is a polling signal — refreshed about every 15 seconds on the Compare and Decide stages — not a real-time channel and not a chat.",
        keywords: ["presence", "active", "online", "polling", "real-time", "chat", "collaboration", "who is here"],
        what:
          "The Experiment Lab header shows who else is active on the case: your browser announces itself and re-fetches the member list about every 15 seconds, and the server forgets anyone not seen for 45 seconds. Presence is intentionally ephemeral — useful for coordination, but never a case fact, audit record, or evidence claim.",
        when:
          "Glance at it before making changes another person might be mid-way through, or to see whether a teammate is reviewing the same record.",
        steps: [
          "Open the investigation's Compare or Decide stage — those are the surfaces that announce presence.",
          "Read the header: how many people are active now, and their usernames.",
          "For durable communication, record a message or note on the timeline instead.",
        ],
        recorded:
          "Nothing durable. A server restart simply clears presence, and the read-only view does not announce you.",
        limits:
          "This is HTTP polling, not a real-time connection — there is no live chat channel, no typing indicators, and no push updates in this build. \"Message\" entries are ordinary timeline contributions, and other panels refresh on their own schedules, not instantly.",
        actions: [{ label: "Open the Compare stage", go: { stage: "compare" } }],
      },
    ],
  },
  {
    id: "privacy",
    title: "Privacy & administration",
    articles: [
      {
        id: "privacy-classes",
        title: "Privacy classes and what leaves the workspace",
        summary:
          "owner_only stays in the case; share_safe is the only material eligible to leave, and exports enforce that server-side.",
        keywords: ["privacy", "owner only", "share safe", "redaction", "data", "leaves", "classes"],
        what:
          "Contributions and evidence each carry a privacy class chosen at capture time. owner_only material is private to the case; share_safe material is eligible for share-safe export. The export pipeline enforces the boundary: share-safe projections exclude owner-only content, replace identities with neutral labels, and are blocked outright when a privacy scan finds credentials, internal hostnames, or raw private evidence.",
        when:
          "Think about the class whenever you capture something — it is much easier to classify honestly at intake than to untangle at export time.",
        steps: [
          "When adding a note or uploading evidence, pick the privacy class deliberately; owner_only is the default.",
          "Before exporting, review the inventory: it lists each item's class and marks what is excluded by default.",
        ],
        recorded:
          "The class is stored on each item and shown wherever the item appears, including the export inventory.",
        limits:
          "Marking something share_safe does not scrub it — the privacy scan is a backstop, not a cleaner. Browser-side, the app talks only to the workspace server; endpoints, credentials, and provider traffic never enter the browser.",
      },
      {
        id: "administration",
        title: "Administration and setup",
        summary:
          "Administrators can discover directory references, manage group-to-role mappings, and test directory connectivity; durable secrets stay operator-owned.",
        keywords: ["admin", "directory", "group", "role", "grant", "revoke", "ldap", "setup", "configuration", "wizard", "operator", "doctor", "static", "read-only", "sample data", "people"],
        what:
          "The Administration page is visible only with the admin:users capability, not merely because a person holds the admin role title. Group role mappings live at /administration. People is a first-class page at /admin/people. Directory connectivity review lives at /admin/ldap and requires admin:system_config in addition to seeing Administration. Search results are references only: finding an identity or group grants nothing, creates nothing, and never changes directory membership. Access comes only from an explicit destination group mapping to viewer, contributor, case-lead, or admin, or from a local capability grant.",
        when:
          "Use this when a directory group needs workspace access, a group's role changes, or a stale mapping must be revoked. Open People when you need to search, suspend, or grant a capability to a person already known to this workspace. Open Directory when you need to review the share-safe LDAP configuration or run a staged connectivity test. Use operator tooling for durable environment files, gateways, database settings, backups, and health checks.",
        steps: [
          "Open Administration from the primary navigation, or go directly to /admin/people for the People tab or /admin/ldap for Directory. Accounts without admin:users cannot see the destination, and a direct route does not request protected administration data.",
          "Search for a group or identity. Results are capped at twenty; refine the term rather than assuming the result is the full directory.",
          "Select or enter the exact group reference, choose one workspace role, and grant it. Existing-role changes, revocation, and every administrator grant require an explicit confirmation.",
          "Refresh Current group permissions to verify the destination state. The server also refreshes its live authorization map from persistent storage on each API request.",
          "On Directory, review the share-safe configuration and optionally run Test directory. Stages distinguish transport, service bind, user search, group lookup, and role-map readiness. Probe passwords are used once and never stored.",
          "A first-run setup wizard can claim the host, prepare a process-local draft, run bounded checks, and optionally probe the directory. Atomic install, restart, and live company-directory qualification remain operator-owned.",
          "In sample-data mode, expect local sample state to reset when its service stops.",
        ],
        recorded:
          "A mapping list is returned only after its successful read is audited. Updates and revocations submit success, failure, or denial audit records, and their server response separately records whether that audit write succeeded. Directory searches record only the search category and outcome — not the search term or returned directory data. Directory tests record only whether the probe was ready, never bind secrets or probe passwords. The console refreshes from the persistent mapping store after a confirmed change.",
        limits:
          "The first-run wizard prepares and checks a draft; it does not complete installation or restart the service. Directory testing never displays stored bind secrets and never returns a probe password. There is still no directory-user editor, group-membership editor, gateway configuration screen, or backup and retention control in this build. The console never trusts imported roles. Administrators manage other people; each signed-in person edits their own profile from My profile, not from this console.",
      },
      {
        id: "my-profile",
        title: "My profile, directory ownership, and attribution",
        summary:
          "See your current display details, edit what this workspace owns, and leave historical records unchanged.",
        keywords: [
          "my profile",
          "profile",
          "display name",
          "ldap",
          "oidc",
          "directory",
          "role",
          "capability",
          "attribution",
          "contact",
          "avatar",
          "self-service",
        ],
        what:
          "My profile is a first-class page at /profile, opened from the account menu. It shows your current display name, username, role title, team, contact fields, avatar metadata, account status, profile source (local, LDAP, or OIDC), directory sync state, and the revision used when saving. A workspace role (viewer, contributor, case-lead, admin) is a bundle of capabilities such as reading investigations or administering people. Capabilities decide what you can do; the profile page only changes how you appear, not those permissions. Historical comments, timeline events, and decisions keep the author name recorded when they were written — saving a new display name never rewrites those records.",
        when:
          "Use it when you need to correct a local display name or contact note, check whether a field is owned by the directory, or understand why a past comment still shows an older name.",
        steps: [
          "Open the account menu in the top bar and choose My profile, or go directly to /profile.",
          "Read the profile source and directory-owned labels. LDAP and OIDC accounts cannot change name, role title, team, or work email here — those stay with the directory.",
          "Edit local-only fields (other contact, avatar, custom fields) and, for a local account, the server-allowed identity fields. Save sends the change with a revision check so overlapping edits cannot silently overwrite each other.",
          "If someone else saved first, keep your draft, review the saved values, then reload or save again.",
        ],
        recorded:
          "Successful saves update the current profile row only. The server audits the attempt. Past authored records are not rewritten.",
        limits:
          "This page never contacts LDAP and never implies that it can. A suspended, disabled, or historical account cannot stay signed in, so My profile is not available in that state. A static read-only snapshot cannot edit. Host provider profiles used by AI lanes are a different kind of profile — see lane help.",
        actions: [{ label: "Go to My profile", go: { area: "profile" } }],
      },
    ],
  },
];

/** Terms defined by what the product records — not aspirational meanings. */
const GLOSSARY: readonly GlossaryEntry[] = [
  {
    term: "investigation",
    definition:
      "The unit of casework: a titled case with a recorded status, severity, participants, timeline, evidence, runs, and decisions. Also called a case.",
  },
  {
    term: "evidence snapshot",
    definition:
      "An immutable, fingerprinted selection of evidence frozen by a case lead. Runs bind to exactly one snapshot and never silently widen to newer evidence.",
  },
  {
    term: "imported run",
    definition:
      "Output pasted in from a tool outside ContextDesk, recorded with importer, operator, stated evidence visibility, and content hashes. It stays marked unverified until a human corroborates or contradicts it.",
  },
  {
    term: "provenance",
    definition:
      "The recorded origin of material: who authored or imported it, what source it is credited to, its content hash, and its revision lineage. Unknown provenance is recorded as unknown, never guessed.",
  },
  {
    term: "lane",
    definition:
      "One candidate within a triage run: an alias, model identity, role, and — for gateway runs — a host profile. Lanes settle independently as completed, partial, failed, timed out, or cancelled.",
  },
  {
    term: "triage run",
    definition:
      "A job binding two or more lanes to one frozen snapshot, in synthetic or gateway mode. It records its snapshot fingerprint, requester, and per-lane results; usage and cost stay unknown.",
  },
  {
    term: "accepted decision",
    definition:
      "A human conclusion a case lead accepted from a proposal. Acceptance is revision-guarded, the accepted text is immutable, and it appears in the case board's Newly concluded bucket.",
  },
  {
    term: "share-safe",
    definition:
      "The privacy class and export variant eligible to leave the case. Share-safe exports are default-deny for private material, redact identities, and must pass a privacy scan.",
  },
  {
    term: "profile",
    definition:
      "A credential-free identifier (ID, label, provider) for a provider configuration the host owns. Lanes reference a profile ID; credentials and endpoints never enter the browser.",
  },
  {
    term: "user profile",
    definition:
      "The current display record for a signed-in person: name, contact, avatar, status, and directory provenance. It is separate from historical attribution and from host provider profiles used by AI lanes.",
  },
  {
    term: "qualification",
    definition:
      "An operator-run, command-line harness that proves lane execution on a host, recording each step as passed, failed, skipped, or partial. Its reports are not displayed in this web app.",
  },
  {
    term: "host profile",
    definition:
      "The profile selected per gateway lane in the launcher, drawn from the host's configured catalog. Choosing one tells the host bridge which provider configuration to use — nothing more.",
  },
  {
    term: "corpus intake",
    definition:
      "Investigation-scoped file, ZIP, or directory import on Capture. Accepted files become ordinary evidence with relative path, digest, privacy class, and provenance; freeze and triage select them without conversion.",
  },
  {
    term: "gold reference",
    definition:
      "A human benchmark promoted from an accepted decision by a case lead. Lanes are scored as aligned, partially aligned, divergent, or unscored against it — alignment is not a correctness verdict.",
  },
];

const STAGE_ACTION_LABELS: Record<StageId, string> = {
  situation: "Situation",
  capture: "Capture",
  analyze: "Analyze",
  compare: "Compare",
  decide: "Decide",
};

const FLOW_STEPS: readonly { name: string; kicker: string; human?: boolean }[] = [
  { name: "Capture", kicker: "evidence in, with provenance" },
  { name: "Analyze", kicker: "snapshots & AI lanes" },
  { name: "Compare", kicker: "lanes on the same evidence" },
  { name: "Decide", kicker: "a person makes the call", human: true },
];

/** Task-first entry points shown under "What are you trying to do?". */
const QUICK_TASKS: readonly { task: string; articleId: string }[] = [
  { task: "Record what you observed", articleId: "record-contributions" },
  { task: "Bring in a run from another tool", articleId: "import-external-run" },
  { task: "Freeze evidence and run AI lanes", articleId: "run-lanes" },
  { task: "Compare models on the same evidence", articleId: "compare-lanes" },
  { task: "Make the call and share it safely", articleId: "share-safe-export" },
  { task: "See who else is active right now", articleId: "presence" },
  { task: "Update my display name or contact details", articleId: "my-profile" },
];

interface ArticleHit {
  kind: "article";
  article: HelpArticle;
  category: HelpCategory;
  score: number;
  snippet: string;
}

interface GlossaryHit {
  kind: "glossary";
  entry: GlossaryEntry;
  score: number;
  snippet: string;
}

type SearchHit = ArticleHit | GlossaryHit;

type Selection =
  | { kind: "article"; id: string }
  | { kind: "glossary"; term?: string }
  | null;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wraps every term occurrence in <mark>; longer terms win the alternation. */
function highlight(text: string, terms: readonly string[]): ReactNode {
  if (terms.length === 0) return text;
  const pattern = [...terms]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const splitter = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(splitter);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? <mark key={index}>{part}</mark> : part,
  );
}

function articleBody(article: HelpArticle): string {
  return [article.what, article.when, article.steps.join(" "), article.recorded, article.limits].join(" ");
}

function snippetAround(field: string, terms: readonly string[]): string | null {
  const lower = field.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (at === -1 || index < at)) at = index;
  }
  if (at === -1) return null;
  const start = Math.max(0, at - 60);
  const end = Math.min(field.length, at + 100);
  return `${start > 0 ? "…" : ""}${field.slice(start, end).trim()}${end < field.length ? "…" : ""}`;
}

function scoreArticle(
  article: HelpArticle,
  category: HelpCategory,
  terms: readonly string[],
): ArticleHit | null {
  const title = article.title.toLowerCase();
  const summary = article.summary.toLowerCase();
  const body = articleBody(article).toLowerCase();
  const keywords = article.keywords.map((keyword) => keyword.toLowerCase());
  let score = 0;
  for (const term of terms) {
    let termScore = 0;
    if (title.includes(term)) termScore += title.startsWith(term) ? 7 : 5;
    if (keywords.some((keyword) => keyword.includes(term))) termScore += 4;
    if (summary.includes(term)) termScore += 3;
    if (body.includes(term)) termScore += 1;
    if (termScore === 0) return null;
    score += termScore;
  }
  const snippet =
    snippetAround(article.summary, terms) ??
    snippetAround(articleBody(article), terms) ??
    article.summary;
  return { kind: "article", article, category, score, snippet };
}

function scoreGlossary(entry: GlossaryEntry, terms: readonly string[]): GlossaryHit | null {
  const term = entry.term.toLowerCase();
  const definition = entry.definition.toLowerCase();
  let score = 0;
  for (const wanted of terms) {
    let termScore = 0;
    if (term.includes(wanted)) termScore += term.startsWith(wanted) ? 8 : 6;
    if (definition.includes(wanted)) termScore += 1;
    if (termScore === 0) return null;
    score += termScore;
  }
  const snippet = snippetAround(entry.definition, terms) ?? entry.definition;
  return { kind: "glossary", entry, score, snippet };
}

function searchHelp(terms: readonly string[]): SearchHit[] {
  const hits: { hit: SearchHit; order: number }[] = [];
  let order = 0;
  for (const category of HELP_CATEGORIES) {
    for (const article of category.articles) {
      const hit = scoreArticle(article, category, terms);
      if (hit) hits.push({ hit, order });
      order += 1;
    }
  }
  for (const entry of GLOSSARY) {
    const hit = scoreGlossary(entry, terms);
    if (hit) hits.push({ hit, order });
    order += 1;
  }
  hits.sort((a, b) => b.hit.score - a.hit.score || a.order - b.order);
  return hits.map((row) => row.hit);
}

function findArticle(id: string): { article: HelpArticle; category: HelpCategory } | null {
  for (const category of HELP_CATEGORIES) {
    const article = category.articles.find((row) => row.id === id);
    if (article) return { article, category };
  }
  return null;
}

function termSlug(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function ArrowGlyph() {
  return (
    <span className="help-flow__arrow" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" focusable="false">
        <path
          d="M4 12h14m0 0-5-5m5 5-5 5"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function HelpCenter(props: {
  /** Navigate the shell to a top-level area. Always available and honest. */
  onOpenArea: (area: HelpAreaTarget) => void;
  /**
   * Navigate back into the focused investigation's stage. Null whenever no
   * investigation context exists — stage links then simply do not render.
   */
  onOpenStage: ((stage: StageId) => void) | null;
}) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const hits = searching ? searchHelp(terms) : [];
  const view = searching
    ? "results"
    : selection === null
      ? "landing"
      : selection.kind;

  // Landing a reader in an article or the glossary hands focus to its title
  // (or the searched term) so keyboard and screen-reader position match what
  // just changed on screen.
  useEffect(() => {
    if (searching || selection === null) return;
    if (selection.kind === "glossary" && selection.term) {
      document.getElementById(`help-term-${termSlug(selection.term)}`)?.focus();
      return;
    }
    headingRef.current?.focus();
  }, [selection, searching]);

  function openArticle(id: string) {
    setQuery("");
    setSelection({ kind: "article", id });
  }

  function openGlossary(term?: string) {
    setQuery("");
    setSelection(term ? { kind: "glossary", term } : { kind: "glossary" });
  }

  function runAction(target: HelpActionTarget) {
    if ("area" in target) props.onOpenArea(target.area);
    else props.onOpenStage?.(target.stage);
  }

  const selectedArticle =
    selection?.kind === "article" ? findArticle(selection.id) : null;

  const resultCount = searching
    ? `${hits.length} result${hits.length === 1 ? "" : "s"} for “${query.trim()}”`
    : "";

  const backButton = (
    <button type="button" className="help-back" onClick={() => setSelection(null)}>
      Back to topics
    </button>
  );

  return (
    <div className="help" data-view={view}>
      <header className="help__masthead">
        <h2 className="app__area-title">Help Center</h2>
        <p className="app__area-copy">
          Task-first guides to the War Room, searchable below. Everything here describes what
          this build actually does — and says so when something is not part of it.
        </p>
        <div className="help__search" role="search">
          <label className="sr-only" htmlFor="help-search-input">
            Search help
          </label>
          <input
            id="help-search-input"
            className="help__search-input"
            type="search"
            placeholder="Search help — try “snapshot”, “share-safe”, or “import”"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" className="help__search-clear" onClick={() => setQuery("")}>
              Clear search
            </button>
          ) : null}
        </div>
        <p className="help__result-count" role="status">
          {resultCount}
        </p>
      </header>
      <div className="help__layout">
        <nav className="help-rail" aria-label="Help topics">
          {HELP_CATEGORIES.map((category) => (
            <div className="help-rail__group" key={category.id}>
              <h3 className="help-rail__category">{category.title}</h3>
              <ul className="help-rail__list">
                {category.articles.map((article) => (
                  <li key={article.id}>
                    <button
                      type="button"
                      className="help-rail__link"
                      aria-current={
                        !searching &&
                        selection?.kind === "article" &&
                        selection.id === article.id
                          ? "true"
                          : undefined
                      }
                      onClick={() => openArticle(article.id)}
                    >
                      {article.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="help-rail__group">
            <h3 className="help-rail__category">Reference</h3>
            <ul className="help-rail__list">
              <li>
                <button
                  type="button"
                  className="help-rail__link"
                  aria-current={
                    !searching && selection?.kind === "glossary" ? "true" : undefined
                  }
                  onClick={() => openGlossary()}
                >
                  Glossary
                </button>
              </li>
            </ul>
          </div>
        </nav>
        <div className="help__main">
          {view === "results" ? (
            hits.length === 0 ? (
              <div className="help-no-results">
                <p>No help articles match &ldquo;{query.trim()}&rdquo;.</p>
                <p>
                  Search covers help titles, summaries, article text, and glossary terms — it
                  does not search your investigations or evidence. Try a shorter term, or browse
                  the topic list.
                </p>
              </div>
            ) : (
              <ul className="help-results" aria-label="Search results">
                {hits.map((hit) => (
                  <li key={hit.kind === "article" ? hit.article.id : `term-${hit.entry.term}`}>
                    <button
                      type="button"
                      className="help-result"
                      onClick={() =>
                        hit.kind === "article"
                          ? openArticle(hit.article.id)
                          : openGlossary(hit.entry.term)
                      }
                    >
                      <span className="help-result__category">
                        {hit.kind === "article" ? hit.category.title : "Glossary"}
                      </span>
                      <span className="help-result__title">
                        {highlight(hit.kind === "article" ? hit.article.title : hit.entry.term, terms)}
                      </span>
                      <span className="help-result__snippet">{highlight(hit.snippet, terms)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          {view === "article" && selectedArticle ? (
            <article className="help-article" aria-labelledby="help-article-title">
              {backButton}
              <p className="help-article__category">{selectedArticle.category.title}</p>
              <h3
                className="help-article__title"
                id="help-article-title"
                tabIndex={-1}
                ref={headingRef}
              >
                {selectedArticle.article.title}
              </h3>
              <p className="help-article__summary">{selectedArticle.article.summary}</p>
              <section className="help-article__section">
                <h4>What this is</h4>
                <p>{selectedArticle.article.what}</p>
              </section>
              <section className="help-article__section">
                <h4>When to use it</h4>
                <p>{selectedArticle.article.when}</p>
              </section>
              <section className="help-article__section">
                <h4>Steps</h4>
                <ol className="help-article__steps">
                  {selectedArticle.article.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </section>
              <section className="help-article__section">
                <h4>What gets recorded</h4>
                <p>{selectedArticle.article.recorded}</p>
              </section>
              <section className="help-article__section help-article__section--limits">
                <h4>Limits</h4>
                <p>{selectedArticle.article.limits}</p>
              </section>
              {(() => {
                const actions = (selectedArticle.article.actions ?? []).filter(
                  (action) => "area" in action.go || props.onOpenStage !== null,
                );
                return actions.length > 0 ? (
                  <div className="help-article__actions">
                    {actions.map((action) => (
                      <button
                        key={action.label}
                        type="button"
                        className="help-article__action"
                        onClick={() => runAction(action.go)}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                ) : null;
              })()}
            </article>
          ) : null}
          {view === "glossary" ? (
            <section className="help-glossary" aria-labelledby="help-glossary-title">
              {backButton}
              <h3
                className="help-article__title"
                id="help-glossary-title"
                tabIndex={-1}
                ref={headingRef}
              >
                Glossary
              </h3>
              <p className="help-article__summary">
                Terms used across the War Room, defined by what the product actually records.
              </p>
              <dl className="help-glossary__list">
                {GLOSSARY.map((entry) => (
                  <div className="help-glossary__entry" key={entry.term}>
                    <dt id={`help-term-${termSlug(entry.term)}`} tabIndex={-1}>
                      <dfn>{entry.term}</dfn>
                    </dt>
                    <dd>{entry.definition}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          {view === "landing" ? (
            <div className="help-landing">
              {props.onOpenStage ? (
                <div
                  className="help-quick-return"
                  role="group"
                  aria-label="Return to your investigation"
                >
                  <p className="help-landing__lede">
                    You opened Help from inside an investigation. Jump back to a work stage:
                  </p>
                  <div className="help-article__actions">
                    {(Object.keys(STAGE_ACTION_LABELS) as StageId[]).map((stage) => (
                      <button
                        key={stage}
                        type="button"
                        className="help-article__action"
                        onClick={() => props.onOpenStage?.(stage)}
                      >
                        {STAGE_ACTION_LABELS[stage]}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <h3 className="help-landing__section-title">What are you trying to do?</h3>
              <ul className="help-quick">
                {QUICK_TASKS.map((quick) => {
                  const target = findArticle(quick.articleId);
                  if (!target) return null;
                  return (
                    <li key={quick.articleId}>
                      <button
                        type="button"
                        className="help-quick__link"
                        onClick={() => openArticle(quick.articleId)}
                      >
                        <span className="help-quick__task">{quick.task}</span>
                        <span className="help-quick__topic">{target.article.title}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <figure className="help-flow" aria-label="How casework flows">
                <ol className="help-flow__steps" aria-label="Capture to Decide flow">
                  {FLOW_STEPS.map((step, index) => (
                    <li className="help-flow__step" key={step.name}>
                      {index > 0 ? <ArrowGlyph /> : null}
                      <span
                        className={
                          step.human
                            ? "help-flow__box help-flow__box--human"
                            : "help-flow__box"
                        }
                      >
                        <span className="help-flow__name">{step.name}</span>
                        <span className="help-flow__kicker">{step.kicker}</span>
                      </span>
                    </li>
                  ))}
                </ol>
                <figcaption className="help-flow__caption">
                  Evidence is captured with provenance, analyzed into frozen snapshots and AI
                  lanes, compared on the same evidence, and decided by a person. Every
                  investigation also has a Situation page — the shared picture of what is
                  recorded so far.
                </figcaption>
              </figure>
              <p className="help-landing__lede">
                Browse all topics in the topic list, or open the glossary for the exact meaning
                of a term. Search covers every article and glossary entry.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
