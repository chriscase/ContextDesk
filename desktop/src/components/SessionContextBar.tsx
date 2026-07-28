/**
 * Session-scoped context pack drop zone (#341) + skill pin (#343).
 * Files land under workspace/.contextdesk/sessions/<id>/context — not permanent roots.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";
import {
  hostListLogCorpora,
  hostListSkills,
  hostListenProcessProgress,
  hostOpenLogExplorer,
  hostSessionContextImportBytes,
  hostSessionContextImportZip,
  hostSessionContextList,
  hostSessionContextRemove,
  type LogCorpusSummaryDto,
  type SessionContextEntryDto,
  type SkillDto,
} from "../lib/host";

type Props = {
  sessionId: string | null;
  disabled?: boolean;
  /** Session-pinned skill id (#343). */
  pinnedSkillId?: string | null;
  onPinnedSkillChange?: (skillId: string | null) => void;
  /** One explicitly attached imported log corpus (#695). */
  linkedCorpusId?: string | null;
  onLinkedCorpusChange?: (corpusId: string | null) => Promise<void> | void;
};

export function SessionContextBar({
  sessionId,
  disabled,
  pinnedSkillId = null,
  onPinnedSkillChange,
  linkedCorpusId = null,
  onLinkedCorpusChange,
}: Props) {
  const [entries, setEntries] = useState<SessionContextEntryDto[]>([]);
  const [corpora, setCorpora] = useState<LogCorpusSummaryDto[]>([]);
  const [corporaLoaded, setCorporaLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [importPhase, setImportPhase] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const addRootRef = useRef<HTMLDivElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);

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

  const refreshCorpora = useCallback(async () => {
    try {
      setCorpora((await hostListLogCorpora()) ?? []);
    } catch {
      setCorpora([]);
    } finally {
      setCorporaLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshCorpora();
  }, [refreshCorpora, sessionId]);

  useEffect(() => {
    void hostListSkills()
      .then((list) => setSkills(list.filter((s) => !s.disabled)))
      .catch(() => setSkills([]));
  }, []);

  useEffect(() => {
    if (
      entries.length > 0 ||
      pinnedSkillId ||
      linkedCorpusId ||
      note ||
      importPhase
    ) {
      setExpanded(true);
    }
  }, [entries.length, importPhase, linkedCorpusId, note, pinnedSkillId]);

  useEffect(() => {
    if (!addOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!addRootRef.current?.contains(event.target as Node)) {
        setAddOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setAddOpen(false);
      addTriggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [addOpen]);

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
        const contextName = f.webkitRelativePath || f.name;
        if (f.name.toLowerCase().endsWith(".zip")) {
          await hostSessionContextImportZip(sessionId, buf);
        } else {
          await hostSessionContextImportBytes(sessionId, contextName, buf);
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
  const linkedCorpus =
    corpora.find((corpus) => corpus.id === linkedCorpusId) ?? null;
  const linkedCorpusUnavailable =
    Boolean(linkedCorpusId) && corporaLoaded && !linkedCorpus;
  const contextSummary =
    entries.length > 0 || pinnedSkillName || linkedCorpusId
      ? [
          entries.length > 0
            ? `${entries.length} attached file${entries.length === 1 ? "" : "s"}`
            : "No files",
          pinnedSkillName ? `Skill: ${pinnedSkillName}` : "No skill",
          linkedCorpusId
            ? linkedCorpusUnavailable
              ? "Log corpus unavailable"
              : `Logs: ${linkedCorpus?.name ?? "loading…"}`
            : "No log corpus",
        ].join(" · ")
      : "No files, skill, or log corpus · session-only";

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
          Files stay scoped to this chat. A selected provider may receive the
          prompt, bounded history, and bounded redacted context retrieved for
          the answer—not an entire attached log corpus.
        </p>
        {onPinnedSkillChange ? (
          <div
            className="session-context-bar__skill-pin"
            data-testid="skill-pin"
          >
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
          {linkedCorpusId ? (
            <div
              className={`session-context-corpus${
                linkedCorpusUnavailable
                  ? " session-context-corpus--unavailable"
                  : ""
              }`}
              role="group"
              aria-label="Attached log corpus"
            >
              <span className="session-context-corpus__kind">Logs</span>
              <span className="session-context-corpus__name">
                {linkedCorpus?.name ?? linkedCorpusId}
              </span>
              <span className="session-context-corpus__meta">
                {linkedCorpusUnavailable
                  ? "Unavailable — grounded log chat is blocked"
                  : linkedCorpus
                    ? `${linkedCorpus.eventCount.toLocaleString()} events · available`
                    : "Checking availability…"}
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={disabled || !linkedCorpus}
                onClick={() => {
                  if (!linkedCorpus) return;
                  setNote(null);
                  void hostOpenLogExplorer(linkedCorpus.id).catch((error) =>
                    setNote(
                      error instanceof Error
                        ? error.message
                        : "Could not open Log Explorer",
                    ),
                  );
                }}
              >
                Open in Explorer
              </button>
              {onLinkedCorpusChange ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={disabled}
                  aria-label={`Detach ${linkedCorpus?.name ?? linkedCorpusId}`}
                  onClick={() => {
                    setNote(null);
                    void Promise.resolve(onLinkedCorpusChange(null)).catch(
                      (error) =>
                        setNote(
                          error instanceof Error
                            ? error.message
                            : "Could not detach log corpus",
                        ),
                    );
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          ) : null}
          {entries.map((e) => (
            <span
              key={e.rel_path}
              className="composer__chip"
              title={e.rel_path}
            >
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
          <div className="session-context-add" ref={addRootRef}>
            <button
              ref={addTriggerRef}
              type="button"
              className="composer__chip session-context-bar__add"
              disabled={disabled}
              aria-expanded={addOpen}
              aria-haspopup="dialog"
              onClick={() => setAddOpen((open) => !open)}
            >
              + Add context
            </button>
            {addOpen ? (
              <div
                className="session-context-add__panel"
                role="dialog"
                aria-label="Add context"
              >
                <div className="session-context-add__section">
                  <strong>Chat-only files</strong>
                  <span className="field__hint">
                    Imported under this chat’s bounded context pack.
                  </span>
                  <div className="session-context-add__actions">
                    <label className="btn btn--ghost btn--sm">
                      Files…
                      <input
                        type="file"
                        multiple
                        hidden
                        disabled={disabled}
                        onChange={(event) => {
                          if (event.target.files) {
                            void onFiles(event.target.files);
                          }
                          event.target.value = "";
                          setAddOpen(false);
                        }}
                      />
                    </label>
                    <label className="btn btn--ghost btn--sm">
                      Folder…
                      <input
                        type="file"
                        multiple
                        hidden
                        disabled={disabled}
                        {...({
                          directory: "",
                          webkitdirectory: "",
                        } as InputHTMLAttributes<HTMLInputElement>)}
                        onChange={(event) => {
                          if (event.target.files) {
                            void onFiles(event.target.files);
                          }
                          event.target.value = "";
                          setAddOpen(false);
                        }}
                      />
                    </label>
                  </div>
                </div>
                <div className="session-context-add__section">
                  <strong>Imported log corpus</strong>
                  <span className="field__hint">
                    One corpus per chat. Scope is enforced by the desktop host.
                  </span>
                  <div
                    className="session-context-add__corpora"
                    aria-label="Imported log corpora"
                  >
                    {!corporaLoaded ? (
                      <span className="field__hint">Loading corpora…</span>
                    ) : corpora.length === 0 ? (
                      <span className="field__hint">
                        No imported log corpora. Import logs from the Logs tab
                        first.
                      </span>
                    ) : (
                      corpora.map((corpus) => (
                        <button
                          key={corpus.id}
                          type="button"
                          className="session-context-add__corpus"
                          disabled={disabled}
                          onClick={() => {
                            setNote(null);
                            void Promise.resolve(
                              onLinkedCorpusChange?.(corpus.id),
                            )
                              .then(() => {
                                setAddOpen(false);
                                addTriggerRef.current?.focus();
                              })
                              .catch((error) =>
                                setNote(
                                  error instanceof Error
                                    ? error.message
                                    : "Could not attach log corpus",
                                ),
                              );
                          }}
                        >
                          <span>{corpus.name}</span>
                          <span>
                            {corpus.eventCount.toLocaleString()} events
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {note ? <p className="field__hint">{note}</p> : null}
      </div>
    </details>
  );
}
