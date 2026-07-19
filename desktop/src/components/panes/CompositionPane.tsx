/**
 * Composition workspace (#293 / ADR 0007): draft memory or file text,
 * hand-edit without tool rounds, commit via user-initiated save.
 */
import { useEffect, useMemo, useState } from "react";

export type CompositionTarget =
  | { kind: "scratch"; title: string; body: string; memKind?: string }
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
  /** Jump to Memory list to pick something to compose. */
  onBrowseMemory?: () => void;
  busy?: boolean;
  note?: string | null;
};

const KIND_OPTIONS = [
  { value: "fact", label: "Fact" },
  { value: "decision", label: "Decision" },
  { value: "bookmark", label: "Bookmark" },
  { value: "preference", label: "Preference" },
  { value: "project_note", label: "Project note" },
  { value: "contact", label: "Contact" },
  { value: "term", label: "Term" },
  { value: "task", label: "Task" },
] as const;

function kindLabel(kind: string): string {
  return KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind;
}

function wordCount(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

export function CompositionPane({
  target,
  onChangeTarget,
  onSave,
  onOpenMemory,
  onBrowseMemory,
  busy,
  note,
}: Props) {
  const [title, setTitle] = useState(target?.title ?? "");
  const [body, setBody] = useState(target?.body ?? "");
  const [scratchKind, setScratchKind] = useState(
    target?.kind === "scratch" ? (target.memKind ?? "project_note") : "project_note",
  );
  const [dirty, setDirty] = useState(false);
  const [localNote, setLocalNote] = useState<string | null>(null);
  const [localTone, setLocalTone] = useState<"ok" | "err" | null>(null);

  const targetKind = target?.kind ?? null;
  const targetId = target && "id" in target ? target.id : null;
  const targetPath = target && "path" in target ? target.path : null;
  const targetTitle = target?.title ?? null;
  const targetBody = target?.body ?? null;
  const targetMemKind = target?.kind === "scratch" ? target.memKind : null;

  // Re-sync when target identity changes
  useEffect(() => {
    if (!targetKind) {
      setTitle("");
      setBody("");
      setDirty(false);
      setLocalNote(null);
      setLocalTone(null);
      return;
    }
    setTitle(targetTitle ?? "");
    setBody(targetBody ?? "");
    if (targetKind === "scratch") {
      setScratchKind(targetMemKind ?? "project_note");
    }
    setDirty(false);
    setLocalNote(null);
    setLocalTone(null);
  }, [targetKind, targetId, targetPath, targetTitle, targetBody, targetMemKind]);

  const words = useMemo(() => wordCount(body), [body]);
  const chars = body.length;

  const handleSave = async () => {
    if (!target) return;
    setLocalNote(null);
    setLocalTone(null);
    const next: CompositionTarget =
      target.kind === "scratch"
        ? { kind: "scratch", title: title || "Untitled draft", body, memKind: scratchKind }
        : target.kind === "memory"
          ? { ...target, title: title || target.title, body }
          : { ...target, title: title || target.title, body };
    try {
      await onSave(next);
      setDirty(false);
      onChangeTarget(next);
      setLocalTone("ok");
    } catch (e) {
      setLocalNote(e instanceof Error ? e.message : String(e));
      setLocalTone("err");
    }
  };

  const startScratch = () => {
    onChangeTarget({
      kind: "scratch",
      title: "",
      body: "",
      memKind: scratchKind,
    });
    setTitle("");
    setBody("");
    setDirty(false);
    setLocalNote(null);
    setLocalTone(null);
  };

  const bindingChips = (() => {
    if (!target) return null;
    if (target.kind === "scratch") {
      return (
        <>
          <span className="compose__chip compose__chip--kind">Scratch</span>
          <span className="compose__chip">Not in store yet</span>
        </>
      );
    }
    if (target.kind === "memory") {
      return (
        <>
          <span className="compose__chip compose__chip--kind">
            {kindLabel(target.memKind)}
          </span>
          <span className="compose__chip">{target.scope}</span>
          <span className="compose__chip" title={target.id}>
            {target.id.slice(0, 8)}…
          </span>
          {target.status && target.status !== "active" ? (
            <span className="compose__chip compose__chip--warn">{target.status}</span>
          ) : null}
        </>
      );
    }
    return (
      <>
        <span className="compose__chip compose__chip--kind">File</span>
        <span className="compose__chip" title={target.path}>
          {target.path.split(/[/\\]/).pop() ?? target.path}
        </span>
      </>
    );
  })();

  const saveLabel =
    busy
      ? "Saving…"
      : target?.kind === "scratch"
        ? "Save as memory"
        : target?.kind === "file"
          ? "Save file"
          : "Save revision";

  const statusNote = localNote ?? note;
  const statusTone =
    localTone ??
    (note
      ? /error|fail|refus/i.test(note)
        ? "err"
        : "ok"
      : null);

  return (
    <div className="pane compose">
      <header className="compose__chrome">
        <h2 className="compose__chrome-title">Compose</h2>
        <div className="compose__meta" aria-live="polite">
          {bindingChips}
          {dirty ? (
            <span className="compose__chip compose__chip--dirty">Unsaved</span>
          ) : target?.kind === "scratch" ? (
            <span className="compose__chip">Draft</span>
          ) : target?.kind === "memory" ? (
            <span className="compose__chip compose__chip--ok">In store</span>
          ) : target?.kind === "file" ? (
            <span className="compose__chip compose__chip--ok">On disk</span>
          ) : null}
        </div>
        <div className="compose__actions">
          {target ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={startScratch}
            >
              New scratch
            </button>
          ) : null}
          {target?.kind === "memory" && onOpenMemory ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onOpenMemory(target.sourceId)}
            >
              Open in Memory
            </button>
          ) : null}
        </div>
      </header>

      {!target ? (
        <div className="compose-empty">
          <div className="compose-empty__glyph" aria-hidden="true" />
          <h3 className="compose-empty__title">Nothing open yet</h3>
          <p className="compose-empty__lead">
            Draft a memory here by hand — no tool round-trip. Agent SoftWrite
            still goes through Accept; Save redacts secrets first.
          </p>
          <div className="compose-empty__paths">
            <button
              type="button"
              className="compose-path"
              data-primary="true"
              onClick={startScratch}
            >
              <span className="compose-path__kicker">Start</span>
              <span className="compose-path__label">New scratch draft</span>
              <span className="compose-path__hint">
                Blank canvas → save into the durable store when ready
              </span>
            </button>
            {onBrowseMemory ? (
              <button
                type="button"
                className="compose-path"
                onClick={onBrowseMemory}
              >
                <span className="compose-path__kicker">Edit</span>
                <span className="compose-path__label">Open from Memory</span>
                <span className="compose-path__hint">
                  Pick a store item, then Compose / edit
                </span>
              </button>
            ) : (
              <div className="compose-path" data-static="true">
                <span className="compose-path__kicker">Edit</span>
                <span className="compose-path__label">From Memory pane</span>
                <span className="compose-path__hint">
                  Select a memory → Compose / edit
                </span>
              </div>
            )}
            <div className="compose-path" data-static="true">
              <span className="compose-path__kicker">Cite</span>
              <span className="compose-path__label">From a chat citation</span>
              <span className="compose-path__hint">
                Click a <code>memory:…</code> citation in chat to open it here
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="compose-doc">
          {target.kind === "memory" && target.status === "retracted" ? (
            <div className="callout callout--warn compose-doc__warn" role="status">
              This memory is retracted. Saving creates a new active revision
              (supersede) rather than editing the tombstone in place.
            </div>
          ) : null}
          <label className="sr-only" htmlFor="compose-title">
            Title
          </label>
          <input
            id="compose-title"
            className="compose-doc__title"
            value={title}
            placeholder="Title"
            onChange={(e) => {
              setTitle(e.target.value);
              setDirty(true);
              setLocalTone(null);
            }}
          />
          <label className="sr-only" htmlFor="compose-body">
            Body
          </label>
          <textarea
            id="compose-body"
            className="compose-doc__body"
            value={body}
            placeholder="Write the memory… facts, decisions, notes. Secrets are redacted on Save."
            onChange={(e) => {
              setBody(e.target.value);
              setDirty(true);
              setLocalTone(null);
            }}
          />
          <footer className="compose-doc__footer">
            <div className="compose-doc__footer-meta">
              {target.kind === "scratch" ? (
                <>
                  <label className="sr-only" htmlFor="compose-kind">
                    Memory kind
                  </label>
                  <select
                    id="compose-kind"
                    className="field__control compose-doc__kind"
                    value={scratchKind}
                    onChange={(e) => {
                      setScratchKind(e.target.value);
                      setDirty(true);
                    }}
                  >
                    {KIND_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
              <span className="compose-doc__count" aria-live="polite">
                {words} words · {chars} chars
              </span>
            </div>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !dirty}
              onClick={() => void handleSave()}
            >
              {saveLabel}
            </button>
            {statusNote ? (
              <p
                className="compose-doc__note"
                data-tone={statusTone ?? undefined}
                role="status"
              >
                {statusNote}
              </p>
            ) : (
              <p className="compose-doc__hint">
                {target.kind === "scratch"
                  ? "Save commits after redaction into the durable store (workspace scope)."
                  : target.kind === "memory"
                    ? "Save supersedes the prior revision — history stays intact."
                    : "Save writes the workspace file."}
              </p>
            )}
          </footer>
        </div>
      )}
    </div>
  );
}
