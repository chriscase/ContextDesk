import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  hostGetHandbookManifest,
  hostGetHandbookPage,
  hostExportHandbookDocument,
  hostOpenExternalUrl,
  hostResolveHandbookLink,
  type HandbookExportFormat,
  type HandbookExportScope,
  type HandbookManifestDto,
  type HandbookPageDto,
} from "../../lib/host";
import { saveFileDialog } from "../../lib/dialogs";
import {
  applyThemeToDocument,
  subscribeThemeChanges,
  THEME_STORAGE_KEY,
} from "../../lib/themeBridge";
import { ContextDeskMark } from "../launch/ContextDeskMark";
import "../../styles/handbook.css";
import {
  collectHandbookHeadings,
  HandbookMarkdown,
  HandbookTableOfContents,
} from "./HandbookMarkdown";
import { renderHandbookExportHtml } from "./HandbookExport";

type Props = {
  initialChapterId?: string;
  onNavigate?: (target: string) => void;
};

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

/** Read-only browser for the bundled engineering handbook (#683). */
export function EngineeringHandbook({ initialChapterId, onNavigate }: Props) {
  const [manifest, setManifest] = useState<HandbookManifestDto | null>(null);
  const [page, setPage] = useState<HandbookPageDto | null>(null);
  const [manifestLoading, setManifestLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const chapterRefs = useRef(new Map<string, HTMLButtonElement>());
  const requestRef = useRef(0);
  const focusPageRef = useRef<string | null>(null);
  const pendingAnchorRef = useRef<string | null>(null);
  const exportMenuRef = useRef<HTMLDetailsElement>(null);

  const headings = useMemo(
    () => collectHandbookHeadings(page?.body ?? ""),
    [page?.body],
  );

  const syncActiveHeading = useCallback(() => {
    const reader = articleRef.current;
    if (!reader) return;
    const visibleHeadings = headings.filter((heading) => heading.level > 1);
    if (visibleHeadings.length === 0) {
      setActiveHeadingId(null);
      return;
    }
    const atEnd =
      reader.scrollHeight > reader.clientHeight &&
      reader.scrollTop + reader.clientHeight >= reader.scrollHeight - 2;
    if (atEnd) {
      setActiveHeadingId(visibleHeadings[visibleHeadings.length - 1].id);
      return;
    }
    const threshold = reader.scrollTop + 72;
    let current = visibleHeadings[0].id;
    for (const heading of visibleHeadings) {
      const node = document.getElementById(heading.id);
      if (!node || node.offsetTop > threshold) break;
      current = heading.id;
    }
    setActiveHeadingId(current);
  }, [headings]);

  const loadChapter = useCallback(
    async (chapterId: string, anchor?: string | null) => {
      const request = requestRef.current + 1;
      requestRef.current = request;
      pendingAnchorRef.current = anchor ?? null;
      setActiveChapterId(chapterId);
      setPageLoading(true);
      setError(null);
      try {
        const nextPage = await hostGetHandbookPage(chapterId);
        if (request !== requestRef.current) return;
        focusPageRef.current = nextPage.id;
        setPage(nextPage);
      } catch (loadError) {
        if (request !== requestRef.current) return;
        setPage(null);
        setError(
          messageFrom(
            loadError,
            "This handbook chapter could not be opened from the bundle.",
          ),
        );
        window.requestAnimationFrame(() => articleRef.current?.focus());
      } finally {
        if (request === requestRef.current) setPageLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    try {
      applyThemeToDocument(localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      // theme-init already supplied a safe default.
    }
    return subscribeThemeChanges((theme) => applyThemeToDocument(theme));
  }, []);

  useEffect(() => {
    let current = true;
    setManifestLoading(true);
    setError(null);
    void hostGetHandbookManifest()
      .then((nextManifest) => {
        if (!current) return;
        setManifest(nextManifest);
        const initial =
          nextManifest.chapters.find(
            (chapter) => chapter.id === initialChapterId,
          ) ?? nextManifest.chapters[0];
        if (initial) {
          void loadChapter(initial.id);
        } else {
          setError("The bundled engineering handbook has no chapters.");
        }
      })
      .catch((manifestError) => {
        if (!current) return;
        setError(
          messageFrom(
            manifestError,
            "The bundled engineering handbook is unavailable.",
          ),
        );
      })
      .finally(() => {
        if (current) setManifestLoading(false);
      });
    return () => {
      current = false;
      requestRef.current += 1;
    };
  }, [initialChapterId, loadChapter]);

  useEffect(() => {
    if (!page || focusPageRef.current !== page.id || pageLoading) return;
    focusPageRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const anchor = pendingAnchorRef.current;
      pendingAnchorRef.current = null;
      const target = anchor
        ? document.getElementById(anchor)
        : articleRef.current?.querySelector<HTMLElement>(
            "[data-handbook-heading], h1",
          );
      if (anchor && target) {
        articleRef.current?.scrollTo?.({
          top: Math.max(0, target.offsetTop - 24),
        });
      } else {
        articleRef.current?.scrollTo?.({ top: 0 });
      }
      target?.focus({ preventScroll: true });
      syncActiveHeading();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [page, pageLoading, syncActiveHeading]);

  useEffect(() => {
    const reader = articleRef.current;
    if (!reader || pageLoading || !page) return;
    let frame = 0;
    const onScroll = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncActiveHeading);
    };
    syncActiveHeading();
    reader.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      reader.removeEventListener("scroll", onScroll);
      window.cancelAnimationFrame(frame);
    };
  }, [page, pageLoading, syncActiveHeading]);

  const navigate = useCallback(
    (target: string) => {
      if (onNavigate) {
        onNavigate(target);
        return;
      }
      if (/^https?:\/\//i.test(target)) {
        void hostOpenExternalUrl(target).catch((navigationError) => {
          setError(
            messageFrom(
              navigationError,
              "That handbook link could not be opened.",
            ),
          );
        });
        return;
      }
      if (!page) return;
      void hostResolveHandbookLink(page.id, target)
        .then((resolved) => {
          if (resolved.kind === "external") {
            return hostOpenExternalUrl(resolved.url);
          }
          if (resolved.pageId === page.id && resolved.anchor) {
            const heading = document.getElementById(resolved.anchor);
            articleRef.current?.scrollTo?.({
              top: Math.max(0, (heading?.offsetTop ?? 24) - 24),
            });
            heading?.focus({ preventScroll: true });
            return;
          }
          return loadChapter(resolved.pageId, resolved.anchor);
        })
        .catch((navigationError) => {
          setError(
            messageFrom(
              navigationError,
              "That handbook link is unavailable in this bundled reference.",
            ),
          );
        });
    },
    [loadChapter, onNavigate, page],
  );

  const moveChapterFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const chapters = manifest?.chapters ?? [];
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? chapters.length - 1
          : event.key === "ArrowDown"
            ? Math.min(index + 1, chapters.length - 1)
            : Math.max(index - 1, 0);
    chapterRefs.current.get(chapters[next]?.id ?? "")?.focus();
  };

  const retry = () => {
    if (activeChapterId) void loadChapter(activeChapterId);
  };

  const exportDocument = async (
    scope: HandbookExportScope,
    format: HandbookExportFormat,
  ) => {
    if (!manifest || !page || exporting) return;
    exportMenuRef.current?.removeAttribute("open");
    setExportStatus(null);
    const extension = format === "html" ? "html" : "md";
    const currentName = page.id
      .split("/")
      .at(-1)
      ?.replace(/\.md$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    const defaultName =
      scope === "complete"
        ? `contextdesk-engineering-handbook.${extension}`
        : `contextdesk-handbook-${currentName || "chapter"}.${extension}`;
    const path = await saveFileDialog(
      `Export ${
        scope === "complete" ? "complete handbook" : "current chapter"
      } as ${format === "html" ? "HTML" : "Markdown"}`,
      defaultName,
      [
        {
          name: format === "html" ? "HTML document" : "Markdown document",
          extensions: [extension],
        },
      ],
    );
    if (!path) return;
    setExporting(true);
    try {
      const pages =
        scope === "complete"
          ? await Promise.all(
              manifest.chapters.map((chapter) =>
                chapter.id === page.id
                  ? Promise.resolve(page)
                  : hostGetHandbookPage(chapter.id),
              ),
            )
          : [page];
      const renderedHtml =
        format === "html"
          ? await renderHandbookExportHtml(
              manifest,
              pages,
              hostResolveHandbookLink,
            )
          : null;
      const bytes = await hostExportHandbookDocument({
        path,
        scope,
        format,
        pageId: scope === "current" ? page.id : null,
        renderedHtml,
      });
      setExportStatus({
        kind: "success",
        message: `Exported ${
          scope === "complete" ? "complete handbook" : "current chapter"
        } · ${format === "html" ? "HTML" : "Markdown"} · ${Math.max(
          1,
          Math.round(bytes / 1024),
        )} KB`,
      });
    } catch (exportError) {
      setExportStatus({
        kind: "error",
        message: messageFrom(
          exportError,
          "The handbook could not be exported.",
        ),
      });
    } finally {
      setExporting(false);
    }
  };

  const loading = manifestLoading || pageLoading;

  return (
    <div className="engineering-handbook" data-testid="engineering-handbook">
      <header className="handbook-header">
        <div className="handbook-header__identity" aria-hidden>
          <ContextDeskMark size={42} />
        </div>
        <div className="handbook-header__title">
          <span>Bundled reference · read-only</span>
          <h1>{manifest?.title ?? "Engineering Handbook"}</h1>
          <p>{manifest?.audience ?? "ContextDesk engineers and reviewers"}</p>
        </div>
        <div className="handbook-header__actions">
          <details className="handbook-export" ref={exportMenuRef}>
            <summary aria-label="Export engineering handbook">
              {exporting ? "Exporting…" : "Export"}
              <span aria-hidden>⌄</span>
            </summary>
            <div aria-label="Handbook export options">
              <strong>Current chapter</strong>
              <button
                type="button"
                disabled={exporting || !page}
                onClick={() => void exportDocument("current", "markdown")}
              >
                Markdown
              </button>
              <button
                type="button"
                disabled={exporting || !page}
                onClick={() => void exportDocument("current", "html")}
              >
                HTML
              </button>
              <strong>Complete handbook</strong>
              <button
                type="button"
                disabled={exporting || !page}
                onClick={() => void exportDocument("complete", "markdown")}
              >
                Markdown
              </button>
              <button
                type="button"
                disabled={exporting || !page}
                onClick={() => void exportDocument("complete", "html")}
              >
                HTML
              </button>
            </div>
          </details>
          <div className="handbook-header__status">
            <span aria-hidden>●</span>
            Offline
          </div>
        </div>
      </header>

      <div className="sr-only" aria-live="polite">
        {exportStatus?.message ??
          (error
            ? `Handbook error: ${error}`
            : loading
              ? "Loading the engineering handbook"
              : page
                ? `Opened ${page.title}`
                : "Engineering handbook ready")}
      </div>

      {exportStatus ? (
        <div
          className="handbook-export-status"
          data-kind={exportStatus.kind}
          role={exportStatus.kind === "error" ? "alert" : "status"}
        >
          {exportStatus.message}
          <button
            type="button"
            aria-label="Dismiss export status"
            onClick={() => setExportStatus(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="handbook-layout">
        <nav className="handbook-chapters" aria-label="Handbook chapters">
          <div className="handbook-rail-label">
            <span>Contents</span>
            <span>{manifest?.chapters.length ?? 0}</span>
          </div>
          {manifestLoading ? (
            <div className="handbook-chapters__skeleton" aria-hidden>
              <span />
              <span />
              <span />
            </div>
          ) : (
            <ol>
              {(manifest?.chapters ?? []).map((chapter, index) => (
                <li key={chapter.id}>
                  <button
                    ref={(node) => {
                      if (node) chapterRefs.current.set(chapter.id, node);
                      else chapterRefs.current.delete(chapter.id);
                    }}
                    type="button"
                    data-active={activeChapterId === chapter.id}
                    aria-current={
                      activeChapterId === chapter.id ? "page" : undefined
                    }
                    onClick={() => void loadChapter(chapter.id)}
                    onKeyDown={(event) => moveChapterFocus(event, index)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{chapter.title}</strong>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <p className="handbook-chapters__hint">
            ↑↓ navigate <span aria-hidden>·</span> Enter open
          </p>
        </nav>

        <main
          className="handbook-reader"
          aria-label="Engineering handbook chapter"
          aria-busy={loading}
          tabIndex={error ? -1 : undefined}
          ref={articleRef}
        >
          {error && !page ? (
            <section className="handbook-state" role="alert">
              <span className="handbook-state__mark" aria-hidden>
                !
              </span>
              <p className="handbook-state__eyebrow">Unable to load</p>
              <h2>Handbook chapter unavailable</h2>
              <p>{error}</p>
              {activeChapterId ? (
                <button type="button" onClick={retry}>
                  Try again
                </button>
              ) : null}
            </section>
          ) : pageLoading || !page ? (
            <section className="handbook-state" aria-label="Loading chapter">
              <span className="handbook-state__spinner" aria-hidden />
              <p>Opening the bundled handbook…</p>
            </section>
          ) : (
            <article data-page-id={page.id}>
              <HandbookMarkdown
                body={page.body}
                headings={headings}
                onNavigate={navigate}
              />
            </article>
          )}
        </main>

        <aside className="handbook-toc" aria-label="On this page">
          <div>
            <div className="handbook-rail-label">
              <span>On this page</span>
              <span>{Math.max(headings.length - 1, 0)}</span>
            </div>
            <HandbookTableOfContents
              headings={headings}
              activeHeadingId={activeHeadingId}
              onActivate={setActiveHeadingId}
            />
            <section className="handbook-toc__note">
              <span aria-hidden>◇</span>
              <div>
                <strong>Living design record</strong>
                <p>
                  This bundled copy documents the proven methods shipped with
                  this build.
                </p>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
