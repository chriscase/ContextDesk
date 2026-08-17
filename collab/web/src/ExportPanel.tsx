import { useEffect, useState, type FormEvent } from "react";

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

export function ExportPanel(props: { caseId: string; canWrite: boolean; canLead: boolean }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [variant, setVariant] = useState<"owner_only" | "share_safe">("owner_only");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [scaffold, setScaffold] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [findings, setFindings] = useState<ScanFinding[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`/api/cases/${props.caseId}/export/inventory`)
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((body: { items?: InventoryItem[] }) => {
        setItems(body.items ?? []);
      });
  }, [props.caseId]);

  const allowed =
    variant === "share_safe" ? props.canLead : props.canWrite;
  if (!props.canWrite && !props.canLead) return null;

  async function postExport(path: string, body: unknown) {
    setError(null);
    setFindings([]);
    const res = await fetch(path, {
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
      setFindings(json.findings ?? []);
      setMarkdown("");
      setSnapshot(null);
      return;
    }
    setMarkdown(json.markdown ?? "");
    setSnapshot(json.payload?.snapshotIdentity ?? null);
  }

  async function exportBrief(event: FormEvent) {
    event.preventDefault();
    await postExport(`/api/cases/${props.caseId}/export/brief`, { variant });
  }

  async function exportPackage(event: FormEvent) {
    event.preventDefault();
    const selection = items
      .filter((item) => selected[`${item.kind}:${item.id}`] && !item.excludedByDefault)
      .map((item) => ({ kind: item.kind, id: item.id }));
    await postExport(`/api/cases/${props.caseId}/export/package`, {
      variant,
      selection,
      promptScaffold: scaffold || null,
    });
  }

  return (
    <section className="export">
      <h3 className="export__title">Export</h3>
      <p className="export__copy">
        Projection only — export never edits the case. <code>share_safe</code> is
        default-deny for raw owner-only artifacts and must pass a privacy scan.
      </p>
      <form className="composer" onSubmit={(e) => void exportBrief(e)}>
        <label className="export__label">
          Variant
          <select
            className="login__input"
            value={variant}
            onChange={(e) => setVariant(e.target.value as "owner_only" | "share_safe")}
          >
            <option value="owner_only">owner_only</option>
            <option value="share_safe" disabled={!props.canLead}>
              share_safe
            </option>
          </select>
        </label>
        <button className="login__submit" type="submit" disabled={!allowed}>
          Export triage brief
        </button>
      </form>
      <form className="composer" onSubmit={(e) => void exportPackage(e)}>
        <fieldset className="export__select">
          <legend>Selected evidence</legend>
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
        </fieldset>
        <textarea
          className="login__input"
          value={scaffold}
          onChange={(e) => setScaffold(e.target.value)}
          rows={2}
          placeholder="Optional prompt scaffold"
        />
        <button className="login__submit" type="submit" disabled={!allowed}>
          Export prompt package
        </button>
      </form>
      {error ? <p className="export__error">{error}</p> : null}
      {findings.length > 0 ? (
        <ul className="export__findings">
          {findings.map((f, i) => (
            <li key={`${f.rule}-${i}`}>
              {f.rule} · {f.path} · {f.excerpt}
            </li>
          ))}
        </ul>
      ) : null}
      {snapshot ? (
        <p className="export__copy">
          Snapshot identity: <code>{snapshot}</code>
        </p>
      ) : null}
      {markdown ? <pre className="export__markdown">{markdown}</pre> : null}
    </section>
  );
}
