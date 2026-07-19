/**
 * Composition workspace (#293 / ADR 0007): draft memory or file text,
 * hand-edit without tool rounds, commit via user-initiated save.
 */
import { useEffect, useState } from "react";

export type CompositionTarget =
  | { kind: "scratch"; title: string; body: string }
  | {
      kind: "memory";
      id: string;
      sourceId: string;
      title: string;
      body: string;
      memKind: string;
      scope: string;
      status?: string;
    }
  | { kind: "file"; path: string; title: string; body: string };

type Props = {
  target: CompositionTarget | null;
  onChangeTarget: (t: CompositionTarget) => void;
  onSave: (t: CompositionTarget) => Promise<void>;
  onOpenMemory?: (sourceId: string) => void;
  busy?: boolean;
  note?: string | null;
};

export function CompositionPane({
  target,
  onChangeTarget,
  onSave,
  onOpenMemory,
  busy,
  note,
}: Props) {
  const [title, setTitle] = useState(target?.title ?? "Untitled draft");
  const [body, setBody] = useState(target?.body ?? "");
  const [dirty, setDirty] = useState(false);
  const [localNote, setLocalNote] = useState<string | null>(null);

  // Re-sync when target identity changes
  useEffect(() => {
    if (!target) {
      setTitle("Untitled draft");
      setBody("");
      setDirty(false);
      return;
    }
    setTitle(target.title);
    setBody(target.body);
    setDirty(false);
  }, [
    target?.kind,
    target && "id" in target ? target.id : null,
    target && "path" in target ? target.path : null,
    target?.title,
    target?.body,
  ]);

  const bindingLabel = !target
    ? "No target"
    : target.kind === "scratch"
      ? "Scratch buffer (not yet in the store)"
      : target.kind === "memory"
        ? `Memory ${target.id.slice(0, 8)}… · ${target.memKind} · ${target.scope}`
        : `File ${target.path}`;

  const handleSave = async () => {
    if (!target) return;
    setLocalNote(null);
    const next: CompositionTarget =
      target.kind === "scratch"
        ? { kind: "scratch", title, body }
        : target.kind === "memory"
          ? { ...target, title, body }
          : { ...target, title, body };
    try {
      await onSave(next);
      setDirty(false);
      onChangeTarget(next);
    } catch (e) {
      setLocalNote(e instanceof Error ? e.message : String(e));
    }
  };

  const startScratch = () => {
    onChangeTarget({
      kind: "scratch",
      title: "Untitled draft",
      body: "",
    });
    setDirty(false);
  };

  return (
    <div className="pane">
      <div className="pane__header">Composition</div>
      <p className="section-lead" style={{ padding: "0 0.75rem" }}>
        Draft and hand-edit durable memories (or scratch text). Agent SoftWrite
        proposals still go through Accept; edits here are yours — Save commits
        after redaction. No tool round-trip required.
      </p>
      <div className="pane__toolbar" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", padding: "0.5rem" }}>
        <button type="button" className="btn btn--ghost btn--sm" onClick={startScratch}>
          New scratch
        </button>
        {target?.kind === "memory" && onOpenMemory ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => onOpenMemory(target.sourceId)}
          >
            Open in Memory
          </button>
        ) : null}
        <span className="field__hint" style={{ alignSelf: "center" }}>
          {bindingLabel}
        </span>
      </div>
      {!target ? (
        <div className="empty-state pane__editor">
          <div className="empty-state__title">Nothing to compose</div>
          <p className="empty-state__body">
            Start a scratch draft, open a memory citation, or pick a memory and
            choose Compose.
          </p>
          <button type="button" className="btn btn--primary" onClick={startScratch}>
            New scratch draft
          </button>
        </div>
      ) : (
        <div className="pane__editor">
          {target.kind === "memory" && target.status === "retracted" ? (
            <div className="callout callout--warn" role="status">
              This memory is retracted. Saving creates a new active revision
              (supersede) rather than editing the tombstone in place.
            </div>
          ) : null}
          <label className="field__label" htmlFor="compose-title">
            Title
          </label>
          <input
            id="compose-title"
            className="field__control"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setDirty(true);
            }}
          />
          <label className="field__label" htmlFor="compose-body">
            Body
          </label>
          <textarea
            id="compose-body"
            className="field__control"
            rows={18}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setDirty(true);
            }}
          />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !dirty}
              onClick={() => void handleSave()}
            >
              {busy ? "Saving…" : target.kind === "scratch" ? "Save as memory" : "Save"}
            </button>
          </div>
          {note || localNote ? (
            <p className="field__hint">{note || localNote}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
