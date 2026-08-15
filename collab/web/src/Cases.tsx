import { useCallback, useEffect, useState, type FormEvent } from "react";

interface CaseRow {
  id: string;
  title: string;
  status: string;
  severity: string;
}

interface TimelineEvent {
  seq: number;
  kind: string;
  actorUsername: string;
  serverTime: string;
  payload: string;
}

export function Cases(props: { roles?: string[] }) {
  const canLead =
    (props.roles ?? []).includes("case-lead") || (props.roles ?? []).includes("admin");
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [title, setTitle] = useState("");

  const refresh = useCallback(async () => {
    const res = await fetch("/api/cases");
    if (!res.ok) return;
    const body = (await res.json()) as { cases?: CaseRow[] };
    setCases(body.cases ?? []);
  }, []);

  const loadTimeline = useCallback(async (id: string) => {
    const res = await fetch(`/api/cases/${id}/timeline`);
    if (!res.ok) return;
    const body = (await res.json()) as { events?: TimelineEvent[] };
    setEvents(body.events ?? []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (active) void loadTimeline(active);
  }, [active, loadTimeline]);

  async function createCase(event: FormEvent) {
    event.preventDefault();
    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, severity: "medium" }),
    });
    if (!res.ok) return;
    const created = (await res.json()) as CaseRow;
    setTitle("");
    setActive(created.id);
    await refresh();
  }

  async function setStatus(status: string) {
    if (!active) return;
    await fetch(`/api/cases/${active}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await refresh();
  }

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!active) return;
    const data = new FormData(event.currentTarget);
    const body = String(data.get("body") ?? "");
    const kind = String(data.get("kind") ?? "note");
    await fetch(`/api/cases/${active}/contributions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, body }),
    });
    event.currentTarget.reset();
    await loadTimeline(active);
  }

  const current = cases.find((c) => c.id === active);

  return (
    <section className="workbench">
      <aside className="case-list">
        <h2 className="case-list__title">Cases</h2>
        <ul className="case-list__items">
          {cases.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setActive(c.id)}>
                {c.title}
              </button>
            </li>
          ))}
        </ul>
        <form className="case-form" onSubmit={(e) => void createCase(e)}>
          <input
            className="login__input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New case title"
            required
          />
          <button className="login__submit" type="submit">
            Create case
          </button>
        </form>
      </aside>
      <article className="case-view">
        {current ? (
          <>
            <h2 className="case-view__title">
              {current.title}{" "}
              <span className="timeline__meta">
                {current.status} / {current.severity}
              </span>
            </h2>
            {canLead ? (
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = String(new FormData(e.currentTarget).get("status") ?? "");
                  void setStatus(next);
                }}
              >
                <select className="login__input" name="status" defaultValue={current.status}>
                  <option value="open">open</option>
                  <option value="monitoring">monitoring</option>
                  <option value="resolved">resolved</option>
                  <option value="archived">archived</option>
                </select>
                <button className="login__submit" type="submit">
                  Update status
                </button>
              </form>
            ) : null}
            <ol className="timeline">
              {events.map((ev) => (
                <li key={ev.seq} className="timeline__item">
                  <div className="timeline__meta">
                    #{ev.seq} {ev.kind} · {ev.actorUsername}
                  </div>
                  <div>{ev.payload}</div>
                </li>
              ))}
            </ol>
            <form className="composer" onSubmit={(e) => void addNote(e)}>
              <select className="login__input" name="kind" defaultValue="note">
                <option value="message">message</option>
                <option value="note">note</option>
                <option value="hypothesis">hypothesis</option>
                <option value="action">action</option>
              </select>
              <textarea className="login__input" name="body" required rows={3} />
              <button className="login__submit" type="submit">
                Add to timeline
              </button>
            </form>
          </>
        ) : (
          <p className="shell__copy">Select or create a case.</p>
        )}
      </article>
    </section>
  );
}
