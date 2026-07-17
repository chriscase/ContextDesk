import { useMemo, useState, type CSSProperties } from "react";
import { IconFile, IconLink } from "./icons";

export type SourceCitation = {
  /** URL or workspace path (used for open / link). */
  id: string;
  /** Short source name (publisher / host / file basename). */
  label: string;
  /** Article or page title for the expanded list. */
  title?: string;
};

type Props = {
  citations: SourceCitation[];
  onOpenFile?: (path: string) => void;
};

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/** Stable pastel hue from a string (for monogram backgrounds). */
function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function monogram(label: string): string {
  const t = label.trim();
  if (!t) return "?";
  const parts = t.split(/[\s./_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return t.slice(0, 2).toUpperCase();
}

function openExternal(url: string) {
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    /* ignore */
  }
}

/**
 * Compact “Sources” control: collapsed row of SVG monograms;
 * expand to show titles that open the source link.
 */
export function SourceCitations({ citations, onOpenFile }: Props) {
  const [open, setOpen] = useState(false);

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: SourceCitation[] = [];
    for (const c of citations) {
      if (!c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out.slice(0, 12);
  }, [citations]);

  if (items.length === 0) return null;

  const activate = (c: SourceCitation) => {
    if (isHttpUrl(c.id)) {
      openExternal(c.id);
      return;
    }
    onOpenFile?.(c.id);
  };

  return (
    <div
      className="sources"
      data-open={open ? "true" : "false"}
      aria-label="Sources"
    >
      <button
        type="button"
        className="sources__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sources__label">Sources</span>
        <span className="sources__icons" aria-hidden>
          {items.map((c) => {
            const name = c.label || "source";
            const hue = hueFromString(name);
            const web = isHttpUrl(c.id);
            return (
              <span
                key={c.id}
                className="sources__icon"
                data-kind={web ? "web" : "file"}
                style={{ ["--src-hue" as string]: String(hue) } as CSSProperties}
                title={c.title || name}
              >
                {web ? (
                  <span className="sources__mono">{monogram(name)}</span>
                ) : (
                  <IconFile className="sources__file-svg" />
                )}
              </span>
            );
          })}
        </span>
        <span className="sources__chev" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open ? (
        <ul className="sources__list">
          {items.map((c) => {
            const name = c.label || "Source";
            const title = (c.title || name).trim();
            const web = isHttpUrl(c.id);
            const hue = hueFromString(name);
            return (
              <li key={c.id} className="sources__item">
                <span
                  className="sources__icon sources__icon--row"
                  style={
                    { ["--src-hue" as string]: String(hue) } as CSSProperties
                  }
                  aria-hidden
                >
                  {web ? (
                    <span className="sources__mono">{monogram(name)}</span>
                  ) : (
                    <IconFile className="sources__file-svg" />
                  )}
                </span>
                <button
                  type="button"
                  className="sources__title"
                  title={c.id}
                  onClick={() => activate(c)}
                >
                  <span className="sources__title-text">{title}</span>
                  <span className="sources__meta">
                    {name}
                    {web ? <IconLink className="sources__ext" /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
