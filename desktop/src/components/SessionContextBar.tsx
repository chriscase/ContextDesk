/**
 * Session-scoped context pack drop zone (#341) + skill pin (#343).
 * Files land under workspace/.contextdesk/sessions/<id>/context — not permanent roots.
 */
import { useCallback, useEffect, useState } from "react";
import {
  hostListSkills,
  hostListenProcessProgress,
  hostSessionContextImportBytes,
  hostSessionContextImportZip,
  hostSessionContextList,
  hostSessionContextRemove,
  type SessionContextEntryDto,
  type SkillDto,
} from "../lib/host";

type Props = {
  sessionId: string | null;
  disabled?: boolean;
  /** Session-pinned skill id (#343). */
  pinnedSkillId?: string | null;
  onPinnedSkillChange?: (skillId: string | null) => void;
};

export function SessionContextBar({
  sessionId,
  disabled,
  pinnedSkillId = null,
  onPinnedSkillChange,
}: Props) {
  const [entries, setEntries] = useState<SessionContextEntryDto[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [importPhase, setImportPhase] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

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

  useEffect(() => {
    void hostListSkills()
      .then((list) => setSkills(list.filter((s) => !s.disabled)))
      .catch(() => setSkills([]));
  }, []);

  useEffect(() => {
    if (entries.length > 0 || pinnedSkillId || note || importPhase) {
      setExpanded(true);
    }
  }, [entries.length, importPhase, note, pinnedSkillId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void hostListenProcessProgress((p) => {
      if (p.kind === "session_context_import") {
        setImportPhase(p.message || p.phase);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const onFiles = async (files: FileList | File[]) => {
    if (!sessionId || disabled) return;
    setNote(null);
    setImportPhase("importing…");
    const list = Array.from(files);
    for (const f of list) {
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        if (f.name.toLowerCase().endsWith(".zip")) {
          await hostSessionContextImportZip(sessionId, buf);
        } else {
          await hostSessionContextImportBytes(sessionId, f.name, buf);
        }
      } catch (e) {
        setNote(e instanceof Error ? e.message : `Failed: ${f.name}`);
      }
    }
    setImportPhase(null);
    await refresh();
  };

  if (!sessionId) return null;

  const pinnedSkillName =
    skills.find((skill) => skill.id === pinnedSkillId)?.name ??
    pinnedSkillId ??
    null;
  const contextSummary =
    entries.length > 0 || pinnedSkillName
      ? [
          entries.length > 0
            ? `${entries.length} attached file${entries.length === 1 ? "" : "s"}`
            : "No files",
          pinnedSkillName ? `Skill: ${pinnedSkillName}` : "No skill",
        ].join(" · ")
      : "No files or skill · session-only";

  return (
    <details
      className={`session-context-bar${dragOver ? " is-dragover" : ""}`}
      data-testid="session-context-bar"
      open={expanded || dragOver}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragOver(true);
        setExpanded(true);
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
      <summary className="session-context-bar__summary">
        <span>Context for this chat</span>
        <span className="session-context-bar__summary-state">
          {contextSummary}
          {importPhase ? ` · ${importPhase}` : ""}
        </span>
      </summary>
      <div className="session-context-bar__body">
        <p className="field__hint session-context-bar__privacy">
          Drop files here for this chat only. They do not become permanent
          workspace sources.
        </p>
        {onPinnedSkillChange ? (
          <div className="session-context-bar__skill-pin" data-testid="skill-pin">
            <label className="field__label" htmlFor="session-skill-pin">
              Skill pin
            </label>
            <select
              id="session-skill-pin"
              className="field__control"
              disabled={disabled}
              value={pinnedSkillId ?? ""}
              onChange={(e) => {
                const v = e.target.value.trim();
                onPinnedSkillChange(v ? v : null);
              }}
              title="Inject this skill playbook on every turn (cannot elevate write grants)"
            >
              <option value="">None</option>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id}
                </option>
              ))}
            </select>
            <span className="field__hint">
              or <code>/skill id</code> once · see docs/SKILLS.md
            </span>
          </div>
        ) : null}
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
    </details>
  );
}
