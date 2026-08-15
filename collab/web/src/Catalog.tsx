import { useCallback, useEffect, useState, type FormEvent } from "react";

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  lifecycle: string;
}

export function Catalog(props: { canLead: boolean }) {
  const [sources, setSources] = useState<SourceRow[]>([]);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/catalog/sources");
    if (!res.ok) return;
    const body = (await res.json()) as { sources?: SourceRow[] };
    setSources(body.sources ?? []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await fetch("/api/catalog/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: String(data.get("name") ?? ""),
        kind: String(data.get("kind") ?? "unknown"),
        description: String(data.get("description") ?? ""),
      }),
    });
    event.currentTarget.reset();
    await refresh();
  }

  async function retire(id: string) {
    await fetch(`/api/catalog/sources/${id}/retire`, { method: "POST" });
    await refresh();
  }

  return (
    <section className="catalog">
      <h2 className="case-list__title">Source catalog</h2>
      <ul className="case-list__items">
        {sources.map((s) => (
          <li key={s.id} className="catalog__row">
            <span>
              {s.name}{" "}
              <span className="timeline__meta">
                {s.kind} / {s.lifecycle}
              </span>
            </span>
            {props.canLead && s.lifecycle === "active" ? (
              <button type="button" className="login__logout" onClick={() => void retire(s.id)}>
                Retire
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {props.canLead ? (
        <form className="composer" onSubmit={(e) => void createSource(e)}>
          <input className="login__input" name="name" placeholder="Source name" required />
          <select className="login__input" name="kind" defaultValue="unknown">
            <option value="human">human</option>
            <option value="external-tool">external-tool</option>
            <option value="internal-system">internal-system</option>
            <option value="contextdesk">contextdesk</option>
            <option value="unknown">unknown</option>
          </select>
          <input className="login__input" name="description" placeholder="Description" />
          <button className="login__submit" type="submit">
            Add source
          </button>
        </form>
      ) : null}
    </section>
  );
}
