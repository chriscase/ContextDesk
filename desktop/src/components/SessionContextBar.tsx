/**
 * Session-scoped context pack drop zone (#341).
 * Files land under workspace/.contextdesk/sessions/<id>/context — not permanent roots.
 */
import { useCallback, useEffect, useState } from "react";
import {
  hostSessionContextImportBytes,
  hostSessionContextList,
  hostSessionContextRemove,
  type SessionContextEntryDto,
} from "../lib/host";

type Props = {
  sessionId: string | null;
  disabled?: boolean;
};

export function SessionContextBar({ sessionId, disabled }: Props) {
  const [entries, setEntries] = useState<SessionContextEntryDto[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setEntries([]);
      return;
    }
    try {
      const list = await hostSessionContextList(sessionId);
      setEntries(list);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not list context");
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onFiles = async (files: FileList | File[]) => {
    if (!sessionId || disabled) return;
    setNote(null);
    const list = Array.from(files);
    for (const f of list) {
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        await hostSessionContextImportBytes(sessionId, f.name, buf);
      } catch (e) {
        setNote(e instanceof Error ? e.message : `Failed: ${f.name}`);
      }
    }
    await refresh();
  };

  if (!sessionId) return null;

  return (
    <div
      className={`session-context-bar${dragOver ? " is-dragover" : ""}`}
      data-testid="session-context-bar"
      onDragEnter={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files?.length) {
          void onFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className="session-context-bar__label">
        Context for this chat
        <span className="field__hint">
          {" "}
          — drop files (session-only; not permanent workspace)
        </span>
      </div>
      <div className="session-context-bar__chips">
        {entries.map((e) => (
          <span key={e.rel_path} className="composer__chip" title={e.rel_path}>
            {e.name}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={disabled}
              aria-label={`Remove ${e.name}`}
              onClick={() => {
                void hostSessionContextRemove(sessionId, e.rel_path).then(
                  () => refresh(),
                );
              }}
            >
              ×
            </button>
          </span>
        ))}
        <label className="composer__chip session-context-bar__add">
          + Add files
          <input
            type="file"
            multiple
            hidden
            disabled={disabled}
            onChange={(ev) => {
              if (ev.target.files) void onFiles(ev.target.files);
              ev.target.value = "";
            }}
          />
        </label>
      </div>
      {note ? <p className="field__hint">{note}</p> : null}
    </div>
  );
}
