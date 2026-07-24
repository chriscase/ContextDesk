import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  hostGetHelpAsset,
  hostGetHelpPage,
  hostListHelpSections,
  hostSearchHelpPages,
  type HelpPageDto,
  type HelpSearchHitDto,
  type HelpSectionDto,
} from "../../lib/host";
import { HelpMarkdown } from "./HelpMarkdown";

export type HelpOpenRequest = {
  requestId: number;
  pageId?: string;
  anchor?: string;
  query?: string;
};

type Props = {
  request?: HelpOpenRequest | null;
};

const SUGGESTED_QUERIES = [
  "How does log analysis work?",
  "When does ContextDesk ask before writing?",
  "Why is prelaunch blocked?",
];

function sectionTitle(sections: HelpSectionDto[], id: string): string {
  return sections.find((section) => section.id === id)?.title ?? id;
}

function scrollToHelpAnchor(anchor: string) {
  const target = document.getElementById(anchor);
  if (target && typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "start" });
  }
}

/** First-class, offline Help documentation browser (#438). */
export function HelpPane({ request }: Props) {
  const [sections, setSections] = useState<HelpSectionDto[]>([]);
  const [page, setPage] = useState<HelpPageDto | null>(null);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HelpSearchHitDto[]>([]);
  const [activeResult, setActiveResult] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const requestHandledRef = useRef<number | null>(null);

  const pageSummaries = useMemo(
    () => sections.flatMap((section) => section.pages),
    [sections],
  );

  const openPage = useCallback(async (pageId: string, anchor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const nextPage = await hostGetHelpPage(pageId);
      const loadedAssets = await Promise.all(
        nextPage.assets.map(async (asset) => {
          try {
            const loaded = await hostGetHelpAsset(pageId, asset.path);
            return [asset.path, loaded.data_url] as const;
          } catch {
            return [asset.path, ""] as const;
          }
        }),
      );
      setPage(nextPage);
      setAssetUrls(Object.fromEntries(loadedAssets.filter(([, url]) => url)));
      window.requestAnimationFrame(() => {
        if (anchor) {
          scrollToHelpAnchor(anchor);
        } else {
          titleRef.current?.focus();
        }
      });
    } catch {
      setError("That Help page could not be opened. Try searching the bundled guide.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    void hostListHelpSections()
      .then((listed) => {
        if (!current) return;
        setSections(listed);
        const initial =
          listed
            .flatMap((section) => section.pages)
            .find((candidate) => candidate.id === "product-overview") ??
          listed[0]?.pages[0];
        if (initial && !request?.pageId && !request?.query) {
          void openPage(initial.id);
        } else if (!initial && !request?.pageId && !request?.query) {
          setError("Bundled Help is unavailable in this installation.");
          setLoading(false);
        }
      })
      .catch(() => {
        if (!current) return;
        setError("Bundled Help is unavailable in this installation.");
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [openPage, request?.pageId, request?.query]);

  useEffect(() => {
    if (!request || requestHandledRef.current === request.requestId) return;
    requestHandledRef.current = request.requestId;
    if (request.query?.trim()) {
      setQuery(request.query.trim());
      return;
    }
    if (request.pageId) {
      setQuery("");
      void openPage(request.pageId, request.anchor);
    }
  }, [openPage, request]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      setActiveResult(0);
      return;
    }
    let current = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void hostSearchHelpPages(trimmed, 12)
        .then((hits) => {
          if (!current) return;
          setResults(hits);
          setActiveResult(0);
          setError(null);
        })
        .catch(() => {
          if (!current) return;
          setResults([]);
          setError("Help search is temporarily unavailable.");
        })
        .finally(() => {
          if (current) setSearching(false);
        });
    }, 140);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const openSearchHit = useCallback(
    (hit: HelpSearchHitDto) => {
      setQuery("");
      void openPage(hit.page_id, hit.anchor ?? undefined);
    },
    [openPage],
  );

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      setQuery("");
      return;
    }
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResult((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResult(
        (index) => (index - 1 + results.length) % results.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      openSearchHit(results[activeResult] ?? results[0]);
    }
  };

  const openHelp = useCallback(
    (pageId: string, anchor?: string) => {
      setQuery("");
      void openPage(pageId, anchor);
    },
    [openPage],
  );

  const related = (page?.meta.related ?? [])
    .map((id) => pageSummaries.find((candidate) => candidate.id === id))
    .filter((candidate) => candidate != null);

  return (
    <div className="help-pane" data-testid="help-pane">
      <header className="help-toolbar">
        <div>
          <span className="help-toolbar__eyebrow">Bundled guide</span>
          <h2>Help Center</h2>
        </div>
        <div className="help-search">
          <label htmlFor="help-search-input">Search Help</label>
          <div className="help-search__control">
            <span aria-hidden>⌕</span>
            <input
              id="help-search-input"
              type="search"
              value={query}
              placeholder="Search features, workflows, and settings"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              aria-controls="help-search-results"
              aria-expanded={Boolean(query)}
            />
            {query ? (
              <button
                type="button"
                className="help-search__clear"
                onClick={() => setQuery("")}
                aria-label="Clear Help search"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="sr-only" aria-live="polite">
        {error ??
          (query
            ? searching
              ? "Searching Help"
              : `${results.length} Help result${results.length === 1 ? "" : "s"}`
            : page
              ? `Opened ${page.meta.title}`
              : "Loading Help")}
      </div>

      {query ? (
        <section
          className="help-results"
          id="help-search-results"
          aria-label="Help search results"
        >
          <div className="help-results__header">
            <div>
              <span className="help-toolbar__eyebrow">Ranked locally</span>
              <h3>
                {searching
                  ? "Searching…"
                  : `${results.length} result${results.length === 1 ? "" : "s"}`}
              </h3>
            </div>
            <span className="help-results__hint">↑↓ move · Enter open · Esc clear</span>
          </div>
          {!searching && results.length === 0 ? (
            <div className="help-empty">
              <strong>No bundled page matched that search.</strong>
              <span>Try a feature name such as “logs”, “memory”, or “permissions”.</span>
            </div>
          ) : (
            <ol className="help-results__list">
              {results.map((hit, index) => (
                <li key={hit.citation}>
                  <button
                    type="button"
                    className="help-result"
                    data-active={index === activeResult}
                    onFocus={() => setActiveResult(index)}
                    onClick={() => openSearchHit(hit)}
                  >
                    <span className="help-result__topline">
                      <strong>{hit.title}</strong>
                      <span>{sectionTitle(sections, hit.section)}</span>
                    </span>
                    {hit.heading ? (
                      <span className="help-result__heading">{hit.heading}</span>
                    ) : null}
                    <span className="help-result__snippet">{hit.snippet}</span>
                    <span className="help-result__score">
                      <span>{hit.mode === "hybrid" ? "Hybrid" : "Keyword"}</span>
                      <span
                        className="help-result__meter"
                        role="img"
                        aria-label={`Relevance score ${hit.score.toFixed(2)}`}
                      >
                        <span style={{ width: `${Math.round(hit.score * 100)}%` }} />
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : (
        <div className="help-browser">
          <nav className="help-nav" aria-label="Help sections">
            <div className="help-nav__suggestions">
              <span>Try asking</span>
              {SUGGESTED_QUERIES.map((suggestion) => (
                <button
                  type="button"
                  key={suggestion}
                  onClick={() => setQuery(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            {sections.map((section) => (
              <section className="help-nav__section" key={section.id}>
                <h3>{section.title}</h3>
                {section.pages.map((summary) => (
                  <button
                    type="button"
                    key={summary.id}
                    data-active={page?.meta.id === summary.id}
                    onClick={() => openHelp(summary.id)}
                  >
                    <span>{summary.title}</span>
                    <small>{summary.summary}</small>
                  </button>
                ))}
              </section>
            ))}
          </nav>

          <main className="help-reader" aria-label="Help article" aria-busy={loading}>
            {error ? (
              <div className="help-reader__state" role="alert">
                <span className="help-reader__state-mark" aria-hidden>!</span>
                <h1>Page unavailable</h1>
                <p>{error}</p>
                <button type="button" onClick={() => setQuery("ContextDesk")}>
                  Search Help
                </button>
              </div>
            ) : loading || !page ? (
              <div className="help-reader__state">
                <span className="help-reader__loader" aria-hidden />
                <p>Opening the bundled guide…</p>
              </div>
            ) : (
              <article className="help-article" data-page-id={page.meta.id}>
                <p className="help-article__summary">{page.meta.summary}</p>
                <HelpMarkdown
                  body={page.body}
                  toc={page.toc}
                  assets={page.assets}
                  assetUrls={assetUrls}
                  onOpenHelp={openHelp}
                  titleRef={titleRef}
                />
              </article>
            )}
          </main>

          <aside className="help-toc" aria-label="On this page">
            <div className="help-toc__sticky">
              <span className="help-toolbar__eyebrow">On this page</span>
              {page?.toc.length ? (
                <ol>
                  {page.toc.map((entry) => (
                    <li key={entry.anchor} data-level={entry.level}>
                      <button
                        type="button"
                        onClick={() => scrollToHelpAnchor(entry.anchor)}
                      >
                        {entry.title}
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>Choose a page to see its outline.</p>
              )}
              {related.length ? (
                <div className="help-related">
                  <span className="help-toolbar__eyebrow">Related</span>
                  {related.map((summary) => (
                    <button
                      type="button"
                      key={summary.id}
                      onClick={() => openHelp(summary.id)}
                    >
                      {summary.title}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
