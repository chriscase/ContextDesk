import { useEffect, useRef, useState, type FormEvent } from "react";
import { protectedApiFetch } from "./protected-api.js";

interface InventoryItem {
  kind: "artifact" | "contribution";
  id: string;
  label: string;
  privacyClass: string;
  contentHash: string | null;
  excludedByDefault: boolean;
}

interface ScanFinding {
  rule: string;
  path: string;
  excerpt: string;
}

type ExportKind = "brief" | "package";
type InventoryStatus = "loading" | "ready" | "error";

function safeFinding(finding: ScanFinding): ScanFinding {
  if (/(credential|secret|token|authorization|request[_-]?id|endpoint|url)/i.test(finding.rule)) {
    return { ...finding, excerpt: "[redacted]" };
  }
  return {
    ...finding,
    excerpt: finding.excerpt.length > 160 ? `${finding.excerpt.slice(0, 157)}…` : finding.excerpt,
  };
}

const NETWORK_ERROR_MESSAGE =
  "The export request did not complete — the server returned no result. Nothing was exported and " +
  "your variant and evidence selection are unchanged; retry with the same export button.";

export function ExportPanel(props: { caseId: string; canWrite: boolean; canLead: boolean }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [inventoryStatus, setInventoryStatus] = useState<InventoryStatus>("loading");
  const [inventoryAttempt, setInventoryAttempt] = useState(0);
  const [variant, setVariant] = useState<"owner_only" | "share_safe">("owner_only");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [scaffold, setScaffold] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [findings, setFindings] = useState<ScanFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ExportKind | null>(null);
  const [completed, setCompleted] = useState<ExportKind | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let stale = false;
    setInventoryStatus("loading");
    void protectedApiFetch(`/api/cases/${props.caseId}/export/inventory`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`inventory request failed (${res.status})`);
        return (await res.json()) as { items?: InventoryItem[] };
      })
      .then((body) => {
        if (stale) return;
        setItems(body.items ?? []);
        setInventoryStatus("ready");
      })
      .catch(() => {
        if (stale) return;
        setInventoryStatus("error");
      });
    return () => {
      stale = true;
    };
  }, [props.caseId, inventoryAttempt]);

  const allowed = variant === "share_safe" ? props.canLead : props.canWrite;
  const selectableItems = items.filter((item) => !item.excludedByDefault);
  const excludedCount = items.length - selectableItems.length;
  const selectedCount = selectableItems.filter(
    (item) => selected[`${item.kind}:${item.id}`],
  ).length;
  const permissionNote = !allowed
    ? variant === "share_safe"
      ? "share_safe exports require the case lead role."
      : "owner_only exports require write access to this case."
    : !props.canLead
      ? "share_safe is available to case leads only."
      : null;
  if (!props.canWrite && !props.canLead) return null;

  async function postExport(kind: ExportKind, path: string, body: unknown) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(kind);
    setCompleted(null);
    setError(null);
    setFindings([]);
    try {
      const res = await protectedApiFetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        error?: string;
        findings?: ScanFinding[];
        markdown?: string;
        payload?: { snapshotIdentity?: string };
      };
      if (!res.ok) {
        setError(json.error ?? "export failed");
        setFindings((json.findings ?? []).map(safeFinding));
        setMarkdown("");
        setSnapshot(null);
        return;
      }
      setMarkdown(json.markdown ?? "");
      setSnapshot(json.payload?.snapshotIdentity ?? null);
      setCompleted(kind);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
      setMarkdown("");
      setSnapshot(null);
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  async function exportBrief(event: FormEvent) {
    event.preventDefault();
    await postExport("brief", `/api/cases/${props.caseId}/export/brief`, { variant });
  }

  async function exportPackage(event: FormEvent) {
    event.preventDefault();
    const selection = items
      .filter((item) => selected[`${item.kind}:${item.id}`] && !item.excludedByDefault)
      .map((item) => ({ kind: item.kind, id: item.id }));
    if (selection.length === 0) return;
    await postExport("package", `/api/cases/${props.caseId}/export/package`, {
      variant,
      selection,
      promptScaffold: scaffold || null,
    });
  }

  return (
    <section className="export" aria-busy={pending !== null ? true : undefined}>
      <h3 className="export__title">Export</h3>
      <p className="export__copy">
        Projection only — export never edits the case. <code>share_safe</code> is
        default-deny for raw owner-only artifacts and must pass a privacy scan.
      </p>
      <form
        className="composer"
        aria-label="Export triage brief"
        onSubmit={(e) => void exportBrief(e)}
      >
        <label className="export__label">
          Variant
          <select
            className="login__input"
            value={variant}
            disabled={pending !== null}
            onChange={(e) => setVariant(e.target.value as "owner_only" | "share_safe")}
          >
            <option value="owner_only">owner_only</option>
            <option value="share_safe" disabled={!props.canLead}>
              share_safe
            </option>
          </select>
        </label>
        {permissionNote ? <p className="case-memory__note">{permissionNote}</p> : null}
        <button className="login__submit" type="submit" disabled={!allowed || pending !== null}>
          Export triage brief
        </button>
      </form>
      <form
        className="composer"
        aria-label="Export selected-evidence prompt package"
        onSubmit={(e) => void exportPackage(e)}
      >
        <fieldset
          className="export__select"
          aria-busy={inventoryStatus === "loading" ? true : undefined}
        >
          <legend>Selected evidence</legend>
          {inventoryStatus === "loading" ? (
            <p className="case-memory__note" role="status">
              Loading evidence inventory…
            </p>
          ) : null}
          {inventoryStatus === "error" ? (
            <>
              <p className="case-memory__error" role="alert">
                The evidence inventory could not be loaded. Check your connection, then retry.
              </p>
              <button
                className="case-memory__secondary-button"
                type="button"
                onClick={() => setInventoryAttempt((attempt) => attempt + 1)}
              >
                Retry loading inventory
              </button>
            </>
          ) : null}
          {inventoryStatus === "ready" && items.length === 0 ? (
            <p className="case-memory__empty">
              This case has no exportable evidence yet, so a selected-evidence prompt package
              cannot be exported.
            </p>
          ) : null}
          {items.map((item) => (
            <label key={`${item.kind}:${item.id}`} className="export__item">
              <input
                type="checkbox"
                disabled={item.excludedByDefault}
                checked={Boolean(selected[`${item.kind}:${item.id}`])}
                onChange={(e) =>
                  setSelected((cur) => ({
                    ...cur,
                    [`${item.kind}:${item.id}`]: e.target.checked,
                  }))
                }
              />
              <span>
                {item.kind} · {item.label} · {item.privacyClass}
                {item.excludedByDefault ? " (excluded by default)" : ""}
              </span>
            </label>
          ))}
          <p className="case-memory__note">
            This package contains only the evidence you select for another analysis tool. It is
            not a full investigation backup and cannot restore this case on another War Room.
          </p>
          {inventoryStatus === "ready" && items.length > 0 ? (
            <p className="case-memory__note" aria-live="polite">
              {selectedCount} of {selectableItems.length} selectable item
              {selectableItems.length === 1 ? "" : "s"} selected.
              {selectedCount === 0
                ? " Select at least one item — a package with no selected evidence cannot be exported."
                : ""}
              {excludedCount > 0
                ? ` ${excludedCount} item${excludedCount === 1 ? " is" : "s are"} excluded by default and never included in packages.`
                : ""}
            </p>
          ) : null}
        </fieldset>
        <label className="export__label">
          Optional prompt scaffold
          <textarea
            className="login__input"
            value={scaffold}
            onChange={(e) => setScaffold(e.target.value)}
            rows={2}
          />
        </label>
        <button
          className="login__submit"
          type="submit"
          disabled={!allowed || pending !== null || selectedCount === 0}
        >
          Export selected-evidence prompt package
        </button>
      </form>
      {pending ? (
        <p className="case-memory__note" role="status">
          {pending === "brief"
            ? "Exporting triage brief…"
            : "Exporting selected-evidence prompt package…"} Export buttons stay disabled until
          it finishes; your selection is preserved.
        </p>
      ) : null}
      {error ? (
        <p className="export__error" role="alert">
          {error}
        </p>
      ) : null}
      {findings.length > 0 ? (
        <>
          <p className="case-memory__note">
            The privacy scan blocked this export; nothing left the case. Excerpts below are
            redacted where they may contain sensitive values.
          </p>
          <ul className="export__findings" aria-label="Privacy scan findings">
            {findings.map((f, i) => (
              <li key={`${f.rule}-${i}`}>
                <span className="imported-run__text">
                  {f.rule} · {f.path} · {f.excerpt}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {completed ? (
        <p className="export__copy" role="status">
          {completed === "brief"
            ? "Triage brief exported."
            : "Selected-evidence prompt package exported."} The result below is a read-only
          projection of the case.
        </p>
      ) : null}
      {snapshot ? (
        <p className="export__copy">
          Snapshot identity: <code className="imported-run__text">{snapshot}</code> — the content
          hash of this export's manifest; identical inputs reproduce the same identity.
        </p>
      ) : null}
      {markdown ? (
        <pre
          className="export__markdown"
          tabIndex={0}
          role="region"
          aria-label="Exported markdown"
        >
          {markdown}
        </pre>
      ) : null}
    </section>
  );
}
