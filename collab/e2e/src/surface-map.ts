/**
 * Capability map for the collaborative triage war-room *demo qualification*.
 *
 * Probed against the isolated `codex/merge-consolidation-demo` integration
 * branch. This map describes the current runnable War-Room surface, not an
 * older remote base or an unmerged PR.
 */
export type SurfaceStatus = "present" | "adapted" | "absent";

export interface SurfaceRow {
  id: string;
  requested: string;
  status: SurfaceStatus;
  actual: string;
  probe: string;
}

export const WAR_ROOM_SURFACE_MAP: SurfaceRow[] = [
  {
    id: "local-auth",
    requested: "local-auth demo login",
    status: "adapted",
    actual:
      "Production boot uses LDAP (`LdapAuthAdapter`). Browser qualification drives the existing test-only `MapAuthAdapter` fixture users over `POST /api/auth/login`. There is no `/api/auth/local` (or similar) route on this branch.",
    probe: "login form → /api/auth/login; invented local-auth paths return 404",
  },
  {
    id: "case-open",
    requested: "create/open a case",
    status: "present",
    actual: "`POST /api/cases` and the Cases list/view. Status values are open / monitoring / resolved / archived.",
    probe: "Create case button and case list",
  },
  {
    id: "evidence-freeze",
    requested: "upload and freeze synthetic evidence",
    status: "present",
    actual:
      "CaseBoardPanel exposes content-addressed evidence upload, selected-evidence snapshot freeze, and immutable snapshot lineage through the case-scoped APIs.",
    probe: "Evidence board → upload → select artifact → Freeze selected evidence",
  },
  {
    id: "comparison-lanes",
    requested: "launch two or more comparison lanes",
    status: "present",
    actual:
      "TriageRunPanel launches a snapshot-bound synthetic or configured-gateway comparison with independently tracked candidate lanes and bounded gateway concurrency.",
    probe: "Run history → Start a snapshot-bound comparison → model lanes",
  },
  {
    id: "run-states",
    requested: "running, partial, failed, cancelled, and completed states",
    status: "present",
    actual:
      "Connected run history renders queued/running/terminal lane progress, same-snapshot proof, partial/failure states, cancellation requests, and honest unknown usage/cost fields.",
    probe: "Run history candidate cards and lane progress",
  },
  {
    id: "import-chat",
    requested: "import a plain-text external chat triage",
    status: "present",
    actual: "`POST /api/cases/:id/imports` plus the Import external run form.",
    probe: "paste fixture transcript and Unverified imported run banner",
  },
  {
    id: "agreement-board",
    requested: "shared/unique evidence, similarities/differences, disagreements, and question paths",
    status: "present",
    actual:
      "Experiment Lab and the case board project shared/unique evidence, disagreements, question-path traces, unknowns, and the explicit agreement-is-not-proof caveat.",
    probe: "Experiment Lab candidate comparison and CaseBoardPanel finding buckets",
  },
  {
    id: "helpfulness",
    requested: "helpfulness and accepted decision",
    status: "present",
    actual:
      "Experiment Lab records attributed helpfulness dimensions, human decisions, accepted state, gold promotion, and separate gold alignment.",
    probe: "Experiment Lab Helpfulness, Decision, and Gold alignment sections",
  },
  {
    id: "share-safe-export",
    requested: "share-safe export",
    status: "present",
    actual:
      "`POST /api/cases/:id/export/brief` and `/export/package` with owner_only | share_safe. share_safe is case-lead+ and privacy-scan fail-closed.",
    probe: "Export triage brief; planted credential findings",
  },
  {
    id: "persistence",
    requested: "reload/restart persistence",
    status: "adapted",
    actual:
      "Same-process reload keeps the HttpOnly session cookie and in-memory case store. Process restart requires Postgres (`/ready` is 503 on the fixture server because pool is null).",
    probe: "page.reload(); restart test skipped without COLLAB_E2E_RESTART_BASE_URL",
  },
  {
    id: "responsive-a11y",
    requested: "responsive layout and basic accessibility",
    status: "present",
    actual:
      "Workbench stacks at 720px. Login labels exist, and the case composer controls have accessible names plus visible keyboard focus states.",
    probe: "375px viewport + labeled login controls + main landmark",
  },
];

export const INVENTED_ROUTES = [
  "/api/auth/local",
  "/api/local-auth/login",
  "/api/lanes",
  "/api/comparisons",
  "/api/war-room",
  "/api/snapshots",
  "/api/cases/demo/freeze",
  "/api/helpfulness",
  "/api/decisions",
] as const;
