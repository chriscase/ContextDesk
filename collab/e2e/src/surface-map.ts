/**
 * Capability map for the collaborative triage war-room *demo qualification*.
 *
 * Probed against `codex/merge-consolidation-v2` HEAD. Local-only commit
 * `37a1579b` is not in this repository and is not assumed. Open PR #935
 * (war-room snapshot/case-board contracts) is also not merged here.
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
    status: "adapted",
    actual:
      "`POST /api/cases/:id/evidence` stores content-addressed immutable blobs. The web shell has no upload control and no snapshot-freeze HTTP API (`cd-collab.snapshot.v1` lives on unmerged PR #935).",
    probe: "API upload + timeline/export inventory; /api/snapshots 404",
  },
  {
    id: "comparison-lanes",
    requested: "launch two or more comparison lanes",
    status: "absent",
    actual:
      "No lane launcher, no `/api/lanes` / `/api/comparisons`. Closest browser analog is two imported external runs on one case.",
    probe: "DOM + invented lane routes 404",
  },
  {
    id: "run-states",
    requested: "running, partial, failed, cancelled, and completed states",
    status: "adapted",
    actual:
      "SDK/bench attempt statuses are not rendered. Case statuses and imported-run corroboration (unverified / corroborated / contradicted) are the shipped browser states. Failed login is the auth failure analog.",
    probe: "case status select + imported-run banners; no lane status badges",
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
    status: "absent",
    actual:
      "No case-board / agreement projection in the UI (PR #935 contracts only). Disagreement analog: corroborate vs contradict an imported run. Question paths have no control.",
    probe: "human judgment form; no shared/unique/question-path headings",
  },
  {
    id: "helpfulness",
    requested: "helpfulness and accepted decision",
    status: "absent",
    actual:
      "No helpfulness score or accepted-decision control. Closest analog is Record human judgment (corroborated / contradicted).",
    probe: "no helpfulness/accepted-decision copy",
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
      "Workbench stacks at 720px. Login labels exist. Several composer fields are placeholder-only (recorded as UI fixes, not product changes in this PR).",
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
