import type {
  HandbookLinkDto,
  HandbookManifestDto,
  HandbookPageDto,
} from "../../lib/host";
import { collectHandbookHeadings, HandbookMarkdown } from "./HandbookMarkdown";

type ResolveLink = (
  fromPageId: string,
  target: string,
) => Promise<HandbookLinkDto>;

const EXPORT_STYLES = `
:root{color-scheme:light dark;--bg:#f5f7fb;--panel:#fff;--raised:#eef2f7;--grid:#dce3ee;--border:#cbd5e1;--text:#18202d;--muted:#566274;--accent:#2868d7;--code:#eef2f7}
@media(prefers-color-scheme:dark){:root{--bg:#0b0d12;--panel:#131720;--raised:#1a202b;--grid:#242c39;--border:#303949;--text:#edf1f7;--muted:#a5afbd;--accent:#76acff;--code:#090b0f}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--text);background:var(--bg);font:16px/1.65 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.export-shell{display:grid;grid-template-columns:minmax(13rem,18rem) minmax(0,1fr);min-height:100vh}.export-nav{position:sticky;top:0;align-self:start;max-height:100vh;overflow:auto;padding:2rem 1.25rem;border-right:1px solid var(--border);background:var(--panel)}.export-brand{margin:0 0 .35rem;font-size:.72rem;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--accent)}.export-nav h1{margin:0 0 .5rem;font-size:1.25rem;line-height:1.2}.export-nav p{margin:0 0 1.5rem;color:var(--muted);font-size:.82rem}.export-nav ol{display:grid;gap:.3rem;margin:0;padding:0;list-style:none}.export-nav a{display:block;padding:.5rem .65rem;border-radius:.55rem;color:var(--muted);font-size:.88rem;font-weight:650;text-decoration:none}.export-nav a:hover,.export-nav a:focus-visible{color:var(--text);background:var(--raised);outline:2px solid var(--accent);outline-offset:1px}
.export-content{min-width:0;padding:clamp(2rem,6vw,5rem)}.export-chapter{width:min(100%,58rem);margin:0 auto 7rem}.export-chapter+.export-chapter{padding-top:4rem;border-top:1px solid var(--border)}article>h1{max-width:22ch;margin:0 0 2rem;font-size:clamp(2.4rem,6vw,4.7rem);line-height:1.02;letter-spacing:-.05em}article h2{margin:3rem 0 1rem;font-size:1.8rem;line-height:1.2}article h3{margin:2.2rem 0 .8rem;font-size:1.3rem}article h4{margin:1.8rem 0 .7rem;color:var(--muted);font-size:1rem;text-transform:uppercase;letter-spacing:.04em}p,li{color:var(--muted)}a{color:var(--accent)}code{font-family:"SFMono-Regular",Consolas,monospace}.handbook-code,.handbook-table,.handbook-diagram{overflow:hidden;margin:2rem 0;border:1px solid var(--border);border-radius:.9rem;background:var(--panel)}.handbook-code>div,.handbook-diagram figcaption{display:flex;justify-content:space-between;gap:1rem;padding:.75rem 1rem;border-bottom:1px solid var(--border);font-size:.78rem}.handbook-code pre,.handbook-diagram pre{overflow:auto;margin:0;padding:1rem;background:var(--code);font-size:.78rem}.handbook-table{overflow:auto}.handbook-table table{width:100%;border-collapse:collapse}.handbook-table th,.handbook-table td{padding:.7rem .8rem;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}.handbook-table th{background:var(--raised)}.handbook-diagram{box-shadow:0 18px 48px rgb(0 0 0/.13)}.handbook-diagram__mark{display:none}.handbook-diagram figcaption span:last-child{display:grid}.handbook-diagram figcaption small{color:var(--muted)}.handbook-diagram__canvas{overflow-x:auto;padding:1rem;background:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:24px 24px}.handbook-diagram__canvas svg{display:block;width:100%;max-height:38rem;margin:auto}.handbook-diagram__svg-node{fill:var(--raised);stroke:var(--accent);stroke-width:1.5}.handbook-diagram__svg-label,.handbook-diagram__svg-message{fill:var(--text);font:700 11px ui-sans-serif,system-ui;text-anchor:middle}.handbook-diagram__svg-message{paint-order:stroke;stroke:var(--panel);stroke-width:5px}.handbook-diagram__svg-edge,.handbook-diagram__svg-lifeline{fill:none;stroke:var(--accent);stroke-width:1.5}.handbook-diagram__svg-lifeline{stroke:var(--border);stroke-dasharray:5 5}.handbook-diagram__svg-arrow{fill:var(--accent)}.handbook-diagram>p{padding:0 1rem;color:var(--muted);font-size:.84rem}.handbook-diagram details{border-top:1px solid var(--border)}.handbook-diagram summary{padding:.7rem 1rem;color:var(--muted);cursor:pointer;font-size:.82rem;font-weight:700}
@media(max-width:52rem){.export-shell{display:block}.export-nav{position:relative;max-height:none;border-right:0;border-bottom:1px solid var(--border)}.export-nav ol{grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))}.export-content{padding:2rem 1rem}.export-chapter{margin-bottom:4rem}}
@media print{body{background:#fff;color:#111}.export-shell{display:block}.export-nav{position:relative;max-height:none;border:0;padding:0 0 2rem;background:#fff}.export-nav a{color:#222}.export-content{padding:0}.export-chapter{width:100%;margin:0;break-before:page}.export-chapter:first-child{break-before:auto}.handbook-code,.handbook-table,.handbook-diagram{box-shadow:none;break-inside:avoid}}
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageSlug(pageId: string): string {
  return pageId
    .replace(/\.md$/i, "")
    .replace(/^docs\/design\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function githubPageUrl(pageId: string, anchor?: string | null): string {
  const path = pageId
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://github.com/chriscase/ContextDesk/blob/main/${path}${
    anchor ? `#${encodeURIComponent(anchor)}` : ""
  }`;
}

function prefixDocumentIds(document: Document, prefix: string) {
  const ids = new Map<string, string>();
  document.querySelectorAll<HTMLElement>("[id]").forEach((node) => {
    const current = node.id;
    const next = `${prefix}--${current}`;
    ids.set(current, next);
    node.id = next;
  });
  for (const attribute of ["aria-labelledby", "aria-describedby"]) {
    document.querySelectorAll<HTMLElement>(`[${attribute}]`).forEach((node) => {
      const value = node.getAttribute(attribute);
      if (!value) return;
      node.setAttribute(
        attribute,
        value
          .split(/\s+/)
          .map((id) => ids.get(id) ?? id)
          .join(" "),
      );
    });
  }
  document.querySelectorAll<SVGElement>("[marker-end]").forEach((node) => {
    const value = node.getAttribute("marker-end");
    const id = value?.match(/^url\(#(.+)\)$/)?.[1];
    if (id && ids.has(id))
      node.setAttribute("marker-end", `url(#${ids.get(id)})`);
  });
}

async function exportChapterMarkup(
  page: HandbookPageDto,
  includedPages: Set<string>,
  resolveLink: ResolveLink,
): Promise<string> {
  const headings = collectHandbookHeadings(page.body);
  const { renderToStaticMarkup } = await import("react-dom/server");
  const markup = renderToStaticMarkup(
    <article data-page-id={page.id}>
      <HandbookMarkdown
        body={page.body}
        headings={headings}
        onNavigate={() => undefined}
      />
    </article>,
  );
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  const prefix = pageSlug(page.id);
  prefixDocumentIds(parsed, prefix);

  for (const button of parsed.querySelectorAll<HTMLButtonElement>(
    "button.handbook-inline-link",
  )) {
    const target = button.title;
    const label = button.textContent?.replace(/↗$/, "").trim() ?? target;
    const anchor = parsed.createElement("a");
    anchor.textContent = label;
    try {
      const resolved = await resolveLink(page.id, target);
      if (resolved.kind === "external") {
        anchor.href = resolved.url;
      } else if (includedPages.has(resolved.pageId)) {
        const destination = pageSlug(resolved.pageId);
        anchor.href = resolved.anchor
          ? `#${destination}--${resolved.anchor}`
          : `#chapter-${destination}`;
      } else {
        anchor.href = githubPageUrl(resolved.pageId, resolved.anchor);
      }
    } catch {
      button.replaceWith(parsed.createTextNode(label));
      continue;
    }
    if (/^https?:\/\//i.test(anchor.href)) {
      anchor.rel = "noreferrer";
    }
    button.replaceWith(anchor);
  }
  return parsed.body.innerHTML;
}

export async function renderHandbookExportHtml(
  manifest: HandbookManifestDto,
  pages: HandbookPageDto[],
  resolveLink: ResolveLink,
): Promise<string> {
  const includedPages = new Set(pages.map((page) => page.id));
  const chapters = await Promise.all(
    pages.map(async (page) => {
      const slug = pageSlug(page.id);
      return `<section class="export-chapter" id="chapter-${slug}" data-source="${escapeHtml(
        page.id,
      )}">${await exportChapterMarkup(page, includedPages, resolveLink)}</section>`;
    }),
  );
  const navigation = pages
    .map(
      (page) =>
        `<li><a href="#chapter-${pageSlug(page.id)}">${escapeHtml(
          page.title,
        )}</a></li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en" data-contextdesk-handbook-export="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="ContextDesk Engineering Handbook">
<title>${escapeHtml(manifest.title)}</title>
<style>${EXPORT_STYLES}</style>
</head>
<body>
<div class="export-shell">
<nav class="export-nav" aria-label="Handbook chapters">
<p class="export-brand">ContextDesk · portable reference</p>
<h1>${escapeHtml(manifest.title)}</h1>
<p>${escapeHtml(manifest.audience)}</p>
<ol>${navigation}</ol>
</nav>
<main class="export-content">${chapters.join("\n")}</main>
</div>
</body>
</html>`;
}

export const __handbookExportTest = {
  pageSlug,
};
