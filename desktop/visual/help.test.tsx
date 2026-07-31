/**
 * Visual acceptance: Help Center pane (HelpPane + HelpMarkdown, #438).
 *
 * Covers: the loaded-article three-column layout (landmarks, reader scroll
 * column, reader measure, title focus affordance) at 1280x800 in dark and
 * light; the 650px stacked narrow layout and the 880px two-column midpoint;
 * the search surface (labelled type=search input, debounced ranked results,
 * arrow-key active row, Escape restore); the unknown-page error state; and
 * axe-core on the loaded article (two pinned product defects excepted —
 * see the FINDING comments).
 *
 * Scope honesty: everything here is renderer-level proof in headless
 * Chromium (real CSS from src/styles/help.css via support/styles, real
 * layout, focus, and ARIA). It is NOT native packaged acceptance — no Tauri
 * shell, and all five host help commands are mocked at the src/lib/host
 * boundary (hostGetHelpPage THROWS outside Tauri, so the mock is
 * load-bearing).
 *
 * Design sources for the assertions: docs/design/HELP_CENTER.md §10.1
 * (three regions, narrow drawer, reader measure, search returns to page),
 * §10.2 (search input contract, relevance meter, keyboard contract), §10.3
 * (landmarks, focus-to-title, polite live region, error fallbacks), and
 * desktop/src/styles/help.css (48rem article cap, 880/650 breakpoints).
 */
import "./support/styles";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HelpPane } from "../src/components/panes/HelpPane";
import { helpOpenRequest } from "../src/lib/help";
import {
  hostGetHelpAsset,
  hostGetHelpPage,
  hostListHelpSections,
  hostOpenEngineeringHandbook,
  hostSearchHelpPages,
} from "../src/lib/host";
import {
  applyTheme,
  expectNoAxeViolations,
  expectNoHorizontalPageOverflow,
  renderVisual,
  resetVisualState,
  setViewport,
  visualStage,
} from "./support/harness";
import {
  helpSections,
  logPage,
  overviewPage,
  pipelineDiagramDataUrl,
  searchHits,
} from "./support/helpFixtures";

// Factory must export every runtime symbol the HelpPane graph imports from
// src/lib/host (repo convention, mirrors HelpPane.test.tsx:12-18; the path
// is ../src/lib/host from visual/ instead of ../../lib/host).
vi.mock("../src/lib/host", () => ({
  hostListHelpSections: vi.fn(),
  hostGetHelpPage: vi.fn(),
  hostGetHelpAsset: vi.fn(),
  hostSearchHelpPages: vi.fn(),
  hostOpenEngineeringHandbook: vi.fn(),
}));

function mustQuery<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`expected element matching ${selector}`);
  return el;
}

/**
 * Render HelpPane inside the same bounded container Workspace gives it:
 * Workspace.tsx mounts the pane in a div.pane-panel (layout.css:523 —
 * flex column, min-height 0, overflow hidden). The explicit 100vh stands in
 * for the app-shell grid track so .help-pane's flex:1/min-height:0 sizing
 * behaves exactly as in production and the reader can actually overflow.
 */
function renderHelp(request?: ReturnType<typeof helpOpenRequest> | null) {
  return renderVisual(
    <div className="pane-panel" style={{ height: "100vh" }}>
      <HelpPane request={request} />
    </div>,
  );
}

async function waitForLoadedArticle(title: string): Promise<HTMLHeadingElement> {
  const heading = (await screen.findByRole("heading", {
    name: title,
    level: 1,
  })) as HTMLHeadingElement;
  // openPage flips loading off after assets settle; aria-busy mirrors it.
  await waitFor(() =>
    expect(
      screen.getByRole("main", { name: "Help article" }).getAttribute("aria-busy"),
    ).toBe("false"),
  );
  return heading;
}

/** Screenshot only after the declared SVG figure has decoded. */
async function waitForFigureDecoded(): Promise<void> {
  await waitFor(() => {
    const img = screen.getByRole("img", { name: "Bounded pipeline overview" });
    // If the asset pipeline failed, HelpMarkdown renders a div fallback
    // (role=img) instead of <img> — fail loudly rather than baking the
    // fallback into a baseline.
    expect(img.tagName).toBe("IMG");
    const image = img as HTMLImageElement;
    expect(image.complete && image.naturalWidth > 0).toBe(true);
  });
}

describe("Help Center pane (visual acceptance)", () => {
  beforeEach(async () => {
    await resetVisualState();
    vi.clearAllMocks();
    vi.mocked(hostListHelpSections).mockResolvedValue(helpSections);
    vi.mocked(hostGetHelpPage).mockImplementation(async (id) => {
      if (id === "product-overview") return overviewPage;
      if (id === "log-analysis-pipeline") return logPage;
      throw new Error(`unknown help page ${id}`);
    });
    vi.mocked(hostGetHelpAsset).mockResolvedValue({
      mime: "image/svg+xml",
      data_url: pipelineDiagramDataUrl,
    });
    // Stable (not Once): window-focus refetches must never drain the mock.
    vi.mocked(hostSearchHelpPages).mockResolvedValue(searchHits);
    vi.mocked(hostOpenEngineeringHandbook).mockResolvedValue(
      "engineering-handbook",
    );
  });

  it("lays out the loaded article as three landmark columns at 1280 and holds dark + light baselines", async () => {
    renderHelp(helpOpenRequest(1, { pageId: "product-overview" }));
    const title = await waitForLoadedArticle("What ContextDesk does");

    // HELP_CENTER.md §10.3 landmark contract.
    const nav = screen.getByRole("navigation", { name: "Help sections" });
    const reader = screen.getByRole("main", { name: "Help article" });
    const toc = screen.getByRole("complementary", { name: "On this page" });

    // FINDING: HELP_CENTER.md §10.3 says focus moves to the article H1 on
    // page navigation. HelpPane.openPage schedules titleRef.current?.focus()
    // on a single requestAnimationFrame (HelpPane.tsx:81-87) that races the
    // React commit of the loaded page: in this headless Chromium run the rAF
    // fires BEFORE the commit (instrumented — the h1 does not exist when the
    // callback runs), the ref is still null, and focus silently stays on
    // <body>. The race outcome is frame-timing dependent, so the automatic
    // hand-off is not asserted either way; the deterministic part of the
    // contract — the H1 is programmatically focusable at tabindex=-1 — is
    // proven below, and manual focus also puts the surface in the designed
    // post-navigation state for the baselines.
    expect(title.tabIndex).toBe(-1);
    title.focus();
    await waitFor(() => expect(document.activeElement).toBe(title));

    // Three columns side by side, all inside 1280px, no page overflow.
    const navRect = nav.getBoundingClientRect();
    const readerRect = reader.getBoundingClientRect();
    const tocRect = toc.getBoundingClientRect();
    expect(navRect.right).toBeLessThanOrEqual(readerRect.left + 1);
    expect(readerRect.right).toBeLessThanOrEqual(tocRect.left + 1);
    expect(tocRect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(Math.abs(navRect.top - readerRect.top)).toBeLessThan(1);
    expect(Math.abs(readerRect.top - tocRect.top)).toBeLessThan(1);
    expectNoHorizontalPageOverflow();

    // The reader is the scrolling column: the long fixture overflows it
    // while the page itself does not scroll vertically.
    expect(reader.scrollHeight).toBeGreaterThan(reader.clientHeight);
    expect(getComputedStyle(reader).overflowY).toBe("auto");
    const doc = document.documentElement;
    expect(doc.scrollHeight).toBeLessThanOrEqual(doc.clientHeight);

    // Sticky TOC mirrors the fixture heading order, deepest level indented.
    const tocButtons = within(toc).getAllByRole("button");
    expect(
      tocButtons.slice(0, 5).map((button) => button.textContent),
    ).toEqual([
      "Getting oriented",
      "The bounded pipeline",
      "Redaction",
      "Boundaries",
      "Recovering from failures",
    ]);

    // Clicking a late TOC entry scrolls the reader column (scroll-margin
    // keeps the h2 near the top) — reader owns the scroll, not the page.
    fireEvent.click(within(toc).getByRole("button", { name: "Recovering from failures" }));
    await waitFor(() => expect(reader.scrollTop).toBeGreaterThan(0));
    expect(doc.scrollTop).toBe(0);
    fireEvent.click(within(toc).getByRole("button", { name: "Getting oriented" }));

    await waitForFigureDecoded();
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "help-article-loaded-dark",
    );

    await applyTheme("light");
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "help-article-loaded-light",
    );
  });

  it("caps the reader measure at help.css's 48rem article width", async () => {
    renderHelp(helpOpenRequest(2, { pageId: "product-overview" }));
    await waitForLoadedArticle("What ContextDesk does");

    const article = mustQuery<HTMLElement>(".help-article");
    const paragraph = mustQuery<HTMLElement>(".help-article > p");
    const rootPx = parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const cap = 48 * rootPx; // .help-article { width: min(100%, 48rem) } — help.css:271
    const articleWidth = article.getBoundingClientRect().width;
    const paragraphWidth = paragraph.getBoundingClientRect().width;
    expect(paragraphWidth).toBeLessThanOrEqual(cap + 0.5);
    expect(Math.abs(paragraphWidth - articleWidth)).toBeLessThan(1);

    // Probe the real rendered ch of the article's own body font.
    const probe = document.createElement("div");
    probe.style.width = "72ch";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    article.appendChild(probe);
    const ch72 = probe.getBoundingClientRect().width;
    probe.remove();

    // FINDING: HELP_CENTER.md §10.1 says "Reader measure stays near 72
    // characters", but the shipped bound is width: min(100%, 48rem)
    // (help.css:271) over a 0.82rem body font (help.css:274). Measured here
    // at 1280x800/dark: paragraph 704px vs 72ch = 595.9px of the same font,
    // i.e. ~85ch (and ~93ch once the 768px cap binds on wider windows).
    // Asserted as current-actual behavior to pin the divergence.
    expect(paragraphWidth).toBeGreaterThan(ch72);
  });

  it("stacks the narrow layout per help.css 650/880 breakpoints", async () => {
    await setViewport("narrow"); // 640x800 — under both breakpoints
    renderHelp(helpOpenRequest(3, { pageId: "product-overview" }));
    await waitForLoadedArticle("What ContextDesk does");

    const browser = mustQuery<HTMLElement>(".help-browser");
    const nav = screen.getByRole("navigation", { name: "Help sections" });
    const reader = screen.getByRole("main", { name: "Help article" });

    // ≤650 (help.css:809): browser becomes a flex column; the labelled
    // section nav stacks above the reader as a bounded (15rem max) region
    // that scrolls internally.
    expect(getComputedStyle(browser).flexDirection).toBe("column");
    const navRect = nav.getBoundingClientRect();
    const readerRect = reader.getBoundingClientRect();
    expect(navRect.bottom).toBeLessThanOrEqual(readerRect.top + 1);
    const rootPx = parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    expect(nav.clientHeight).toBeLessThanOrEqual(15 * rootPx + 1);
    expect(nav.scrollHeight).toBeGreaterThan(nav.clientHeight);

    // FINDING: HELP_CENTER.md §10.1 says the in-page TOC "becomes a
    // disclosure above the article" at narrow widths; help.css:800 instead
    // removes it entirely (display:none) and the nav is a plain stacked
    // region, not a collapsible drawer. Asserted as current-actual.
    expect(getComputedStyle(mustQuery(".help-toc")).display).toBe("none");

    // ≤650 toolbar collapses to a single grid track (help.css:810).
    const toolbarColumns = getComputedStyle(
      mustQuery(".help-toolbar"),
    ).gridTemplateColumns;
    expect(toolbarColumns.includes(" ")).toBe(false);

    expectNoHorizontalPageOverflow();
    await waitForFigureDecoded();
    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "help-article-loaded-dark-narrow",
    );

    // Midpoint 651–880 (help.css:795): two columns, TOC still hidden.
    await page.viewport(800, 800);
    await waitFor(() => {
      const midNav = nav.getBoundingClientRect();
      const midReader = reader.getBoundingClientRect();
      expect(midNav.right).toBeLessThanOrEqual(midReader.left + 1);
      expect(Math.abs(midNav.top - midReader.top)).toBeLessThan(1);
    });
    expect(getComputedStyle(mustQuery(".help-toc")).display).toBe("none");
    expectNoHorizontalPageOverflow();
  });

  it("searches with a labelled type=search input, ranked results, arrow-key row, and Escape restore", async () => {
    renderHelp(helpOpenRequest(4, { pageId: "product-overview" }));
    await waitForLoadedArticle("What ContextDesk does");

    // §10.2: explicit label + type="search".
    const input = screen.getByRole("searchbox", {
      name: "Search Help",
    }) as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("search");
    expect(input.id).toBe("help-search-input");
    expect(
      document.querySelector('label[for="help-search-input"]'),
    ).not.toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");

    fireEvent.change(input, { target: { value: "bounded pipeline" } });
    expect(input.getAttribute("aria-expanded")).toBe("true");

    // 140ms debounce (HelpPane.tsx:158-174) — wait for the ranked list.
    const results = await screen.findByRole("region", {
      name: "Help search results",
    });
    await waitFor(() =>
      expect(
        within(results).getAllByRole("listitem").length,
      ).toBe(searchHits.length),
    );
    expect(
      within(results).getByRole("heading", { name: "3 results" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear Help search" })).toBeTruthy();

    // §10.2: relevance meter labelled Keyword/Hybrid, numeric score exposed
    // to assistive text only.
    expect(within(results).getByText("Hybrid")).toBeTruthy();
    expect(within(results).getAllByText("Keyword")).toHaveLength(2);
    expect(
      within(results).getByRole("img", { name: "Relevance score 0.92" }),
    ).toBeTruthy();
    expect(
      within(results).getByRole("img", { name: "Relevance score 0.61" }),
    ).toBeTruthy();

    // §10.2 keyboard contract: arrows move the active row; exactly one row
    // carries data-active at a time.
    const rows = within(results)
      .getAllByRole("button")
      .filter((button) => button.classList.contains("help-result"));
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(rows[1].getAttribute("data-active")).toBe("true");
    expect(
      results.querySelectorAll('[data-active="true"]'),
    ).toHaveLength(1);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(rows[0].getAttribute("data-active")).toBe("true");

    await expect(page.elementLocator(visualStage())).toMatchScreenshot(
      "help-search-results-dark",
    );

    // §10.1/§10.2: Escape clears, and clearing returns to the current page.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Help search results" }),
      ).toBeNull(),
    );
    expect(
      mustQuery<HTMLElement>(".help-article").getAttribute("data-page-id"),
    ).toBe("product-overview");
  });

  it("shows a recoverable Page-unavailable state for an unknown page id", async () => {
    renderHelp(helpOpenRequest(5, { pageId: "missing-page" }));

    // §10.3 controlled-error fallback: labelled alert, not a blank column.
    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByRole("heading", { name: "Page unavailable" }),
    ).toBeTruthy();
    expect(
      within(alert).getByText(/Try searching the bundled guide/),
    ).toBeTruthy();
    // The section nav survives the failed page so navigation stays possible.
    expect(
      screen.getByRole("navigation", { name: "Help sections" }),
    ).toBeTruthy();

    // The escape hatch is live: it seeds a search and the ranked surface
    // replaces the error state.
    fireEvent.click(within(alert).getByRole("button", { name: "Search Help" }));
    await screen.findByRole("region", { name: "Help search results" });
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("region", { name: "Help search results" }),
        ).getAllByRole("listitem").length,
      ).toBe(searchHits.length),
    );
  });

  it("has no axe violations on the loaded article (dark), two pinned defects excepted", async () => {
    renderHelp(helpOpenRequest(6, { pageId: "product-overview" }));
    await waitForLoadedArticle("What ContextDesk does");
    await waitForFigureDecoded();

    // The reader column itself passes the full axe ruleset.
    await expectNoAxeViolations(
      screen.getByRole("main", { name: "Help article" }),
    );

    // The whole pane passes with exactly two rules off, both real product
    // defects pinned as findings (details in the suite report):
    // - FINDING(aria-allowed-attr, critical): #help-search-input is an
    //   input[type=search] (role searchbox) carrying aria-expanded, which
    //   ARIA 1.2 does not allow on searchbox — HelpPane.tsx:241. The
    //   combobox pattern (or dropping aria-expanded/aria-controls) fixes it.
    // - FINDING(color-contrast, serious): the active section-nav row's
    //   summary line (.help-nav__section > button[data-active="true"] small,
    //   --text-faint 9px on the --accent-soft row background) measures
    //   3.78:1 in the dark skin — below the 4.5:1 minimum (help.css:251-259).
    await expectNoAxeViolations(visualStage(), {
      disableRules: ["aria-allowed-attr", "color-contrast"],
    });
  });
});
