import { expect, test, type Locator, type Page } from "@playwright/test";
import { uniqueTitle, loginAs } from "../src/helpers.js";
import {
  BrowserConformanceRun,
  assertBrowserSurfaceCovered,
  assertProfileParity,
  expectCanonicalNavigation,
  expectForcedColors,
  expectKeyboardEquivalents,
  expectNoDragOnlyCoreFlow,
  expectReducedMotion,
  expectReflow,
  expectSemanticRolesAndLabels,
  type BrowserConformanceRequirementId,
  type ReflowRequirementId,
} from "../src/investigation-strategy/conformance.js";
import { FIXTURE_USERS } from "../src/users.js";

const DESKTOP = { width: 1280, height: 900 };

/**
 * The browser surface of the shared strategy conformance profile, split across
 * the journeys below. Each journey owns its slice and fails if it never reaches
 * one; `assertBrowserSurfaceCovered` proves the slices leave no requirement
 * unclaimed. Assertions that are specific to Investigation First stay in this
 * spec — the shared harness only ever asserts the strategy-neutral baseline.
 */
const KEYBOARD_SLICE: readonly BrowserConformanceRequirementId[] = [
  "semantic-roles-and-labels",
  "canonical-navigation",
  "keyboard-equivalents",
  "no-drag-only-core-flow",
];
const REFLOW_SLICE: readonly ReflowRequirementId[] = ["reflow-560", "reflow-390"];
const REDUCED_MOTION_SLICE: readonly BrowserConformanceRequirementId[] = ["reduced-motion"];
const FORCED_COLORS_SLICE: readonly BrowserConformanceRequirementId[] = ["forced-colors"];

function strategyRoot(page: Page): Locator {
  return page.locator(".investigation-first");
}

async function useInvestigationFirst(page: Page): Promise<void> {
  const before = new URL(page.url());
  const account = page.getByRole("button", { name: `Signed in as ${FIXTURE_USERS.dave.username}` });
  await account.focus();
  await page.keyboard.press("Enter");

  const strategy = page.getByRole("radio", { name: /^Investigation First/ });
  await strategy.focus();
  await page.keyboard.press("Space");
  await expect(strategy).toBeChecked();
  await expect(page.locator(".topbar__title-app")).toHaveText("Investigation First");

  await page.keyboard.press("Escape");
  await expect(account).toBeFocused();
  const after = new URL(page.url());
  expect(after.pathname).toBe(before.pathname);
  expect(after.search).toBe(before.search);
  expect(after.hash).toBe(before.hash);
}

async function createWithKeyboard(page: Page, title: string): Promise<string> {
  const titleField = page.getByLabel("What should the team call this?");
  const severity = page.getByLabel("Severity");
  const observed = page.getByLabel("What was observed?");
  const affected = page.getByLabel("Who or what is affected?");
  const impact = page.getByLabel("What is the impact?");
  const advanced = page.locator(".investigation-first__advanced > summary");
  const submit = page.getByRole("button", { name: "Create investigation" });

  await titleField.focus();
  await page.keyboard.press("Tab");
  await expect(severity).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(observed).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(affected).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(impact).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(advanced).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();

  await titleField.focus();
  await page.keyboard.type(title);
  await severity.focus();
  await expect(severity).toHaveValue("medium");
  await observed.focus();
  await page.keyboard.type("Synthetic checkout requests time out after the fixture deployment.");
  await affected.focus();
  await page.keyboard.type("Fixture shoppers and the synthetic checkout service.");
  await impact.focus();
  await page.keyboard.type("Synthetic orders cannot complete.");

  await advanced.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".investigation-first__advanced")).toHaveAttribute("open", "");
  const product = page.getByRole("combobox", { name: "Product or software" });
  const build = page.getByRole("combobox", { name: "Build" });
  await product.focus();
  await page.keyboard.type("Fixture Storefront");
  await build.focus();
  await page.keyboard.type("fixture-build-27");

  const [created] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith("/api/cases") && response.request().method() === "POST",
    ),
    (async () => {
      await submit.focus();
      await page.keyboard.press("Enter");
    })(),
  ]);
  expect(created.ok(), await created.text()).toBeTruthy();
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeFocused();
  const match = new URL(page.url()).pathname.match(/^\/investigations\/([^/]+)\/situation$/u);
  expect(match, "creation did not land on the canonical investigation URL").toBeTruthy();
  return match![1]!;
}

async function activate(control: Locator, page: Page, key: "Enter" | "Space" = "Enter") {
  await control.focus();
  await expect(control).toBeFocused();
  await page.keyboard.press(key);
}

test.describe("Investigation First accessibility and browser conformance", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await loginAs(page, FIXTURE_USERS.dave);
    await page.goto("/investigations");
    await useInvestigationFirst(page);
    await expect(page.locator(".investigation-first")).toBeVisible();
  });

  test("names, landmarks, order, and core workflows are keyboard-operable without drag", async ({ page }) => {
    test.setTimeout(120_000);
    const run = new BrowserConformanceRun("Investigation First", KEYBOARD_SLICE);
    const root = strategyRoot(page);
    const semantics: string[] = [];

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("region", { name: "Investigations" }).first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Create an investigation" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Investigations", exact: true }).last()).toBeVisible();

    await expect(page.locator(".investigation-first h1, .investigation-first h2")).toHaveText([
      "Make the next useful action obvious.",
      "Create an investigation",
      "Investigations",
    ]);
    semantics.push(`collection view: ${await expectSemanticRolesAndLabels(page, root)}`);

    const skip = page.locator("a.skip-link");
    // Reloading the same canonical route clears Chromium's remembered tab
    // starting point while proving the shipped personal preference persists.
    await page.reload();
    await expect(page.locator(".investigation-first")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();

    const title = uniqueTitle("Investigation First keyboard proof");
    const caseId = await createWithKeyboard(page, title);
    await expect(page).toHaveURL(`/investigations/${caseId}/situation`);
    await expect(page.getByRole("region", { name: "Evidence inventory" })).toBeVisible();
    semantics.push(`record view: ${await expectSemanticRolesAndLabels(page, root)}`);
    run.record("semantic-roles-and-labels", semantics.join("; "));

    const file = page.getByRole("button", { name: "File", exact: true });
    await expect(file).toHaveAttribute("type", "file");
    await file.focus();
    await expect(file).toBeFocused();
    await file.setInputFiles({
      name: "keyboard-proof.log",
      mimeType: "text/plain",
      buffer: Buffer.from("fixture checkout timeout\n", "utf8"),
    });
    const kind = page.locator("select[name='kind']");
    await kind.focus();
    await expect(kind).toBeFocused();
    const annotation = page.locator("input[name='summary']");
    await expect(annotation.locator("xpath=ancestor::label[1]")).toContainText("Annotation");
    await annotation.focus();
    await page.keyboard.type("Synthetic log proving keyboard evidence intake.");
    const addEvidence = page.getByRole("button", { name: "Add to evidence inventory" });
    const [uploaded] = await Promise.all([
      page.waitForResponse(
        (response) => response.url().endsWith(`/api/cases/${caseId}/evidence`) && response.request().method() === "POST",
      ),
      activate(addEvidence, page),
    ]);
    expect(uploaded.ok(), await uploaded.text()).toBeTruthy();

    const evidence = page.getByRole("checkbox", { name: /keyboard-proof\.log/u });
    await activate(evidence, page, "Space");
    await expect(evidence).toBeChecked();
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    const metadata = page.locator(".investigation-first__evidence-list details > summary", {
      hasText: "Metadata",
    });
    await activate(metadata, page);
    await expect(metadata.locator("..")).toHaveAttribute("open", "");

    const back = page.getByRole("button", { name: /Back to investigations/u });
    await activate(back, page);
    await expect(page).toHaveURL("/investigations");
    await expect(page.getByRole("heading", { level: 2, name: "Investigations" })).toBeFocused();

    const search = page.getByRole("searchbox", { name: "Search investigations" });
    await search.focus();
    await page.keyboard.type(title);
    const result = page.locator(".investigation-first__list-button").filter({ hasText: title });
    await activate(result, page);
    await expect(page).toHaveURL(`/investigations/${caseId}/situation`);
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeFocused();
    run.record(
      "canonical-navigation",
      await expectCanonicalNavigation(page, root, {
        pathname: /^\/investigations\/[^/]+\/situation$/u,
      }),
    );

    const archive = page.getByRole("button", { name: "Archive investigation" });
    await activate(archive, page);
    const confirmArchive = page.getByRole("button", { name: "Confirm archive investigation" });
    const [archived] = await Promise.all([
      page.waitForResponse(
        (response) => response.url().endsWith(`/api/cases/${caseId}/lifecycle`) && response.request().method() === "POST",
      ),
      activate(confirmArchive, page),
    ]);
    expect(archived.ok(), await archived.text()).toBeTruthy();
    await expect(
      page.locator(".investigation-first__detail .status-pill--archived"),
    ).toHaveText("archived");

    const restore = page.getByRole("button", { name: "Restore investigation" });
    await activate(restore, page);
    const confirmRestore = page.getByRole("button", { name: "Confirm restore investigation" });
    const [restored] = await Promise.all([
      page.waitForResponse(
        (response) => response.url().endsWith(`/api/cases/${caseId}/lifecycle`) && response.request().method() === "POST",
      ),
      activate(confirmRestore, page),
    ]);
    expect(restored.ok(), await restored.text()).toBeTruthy();
    await expect(
      page.locator(".investigation-first__detail .status-pill--archived"),
    ).toHaveCount(0);
    await expect(page).toHaveURL(`/investigations/${caseId}/situation`);

    run.record(
      "keyboard-equivalents",
      await expectKeyboardEquivalents(page, [
        page.getByRole("button", { name: /Back to investigations/u }),
        page.getByRole("button", { name: "Open War Room technical tools" }),
        page.getByRole("button", { name: "Add to evidence inventory" }),
        page.getByRole("button", { name: "Archive investigation" }),
      ]),
    );
    run.record("no-drag-only-core-flow", await expectNoDragOnlyCoreFlow(page, root));

    expect(
      await page.locator(".investigation-first [draggable=true]").count(),
      "a core Investigation First action unexpectedly requires a drag target",
    ).toBe(0);
    expect(run.finish().evaluated.map((evidence) => evidence.id)).toEqual([...KEYBOARD_SLICE]);
  });

  test("reflows at 200% desktop-zoom and handset widths without page-level horizontal scroll", async ({ page }) => {
    test.setTimeout(120_000);
    const run = new BrowserConformanceRun("Investigation First", REFLOW_SLICE);
    const title = uniqueTitle("Investigation First reflow proof");
    const caseId = await createWithKeyboard(page, title);

    await activate(page.getByRole("button", { name: /Back to investigations/u }), page);
    await expect(page).toHaveURL("/investigations");

    const collectionControls = () => [
      page.getByRole("searchbox", { name: "Search investigations" }),
      page.getByRole("combobox", { name: "Filter investigations by status" }),
      page.getByLabel("What should the team call this?"),
      page.locator(".investigation-first__advanced > summary"),
      page.locator(".investigation-first__list-button").filter({ hasText: title }),
    ];
    const recordControls = () => [
      page.getByRole("button", { name: /Back to investigations/u }),
      page.getByRole("button", { name: "Open War Room technical tools" }),
      page.getByRole("button", { name: "Add to evidence inventory" }),
      page.getByRole("button", { name: "Archive investigation" }),
    ];

    for (const requirement of REFLOW_SLICE) {
      const observed: string[] = [];
      await page.setViewportSize(DESKTOP);
      await page.goto("/investigations");
      await expect(page.locator(".investigation-first")).toBeVisible();
      observed.push(`collection view: ${await expectReflow(page, requirement, collectionControls())}`);

      const result = page.locator(".investigation-first__list-button").filter({ hasText: title });
      await activate(result, page);
      await expect(page).toHaveURL(`/investigations/${caseId}/situation`);
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
      observed.push(`record view: ${await expectReflow(page, requirement, recordControls())}`);

      // The upload grid is Investigation First's own single-column promise at a
      // narrow width, so it stays here rather than in the shared harness.
      const uploadColumns = await page.locator(".investigation-first__upload-grid").evaluate((node) =>
        getComputedStyle(node).gridTemplateColumns,
      );
      expect(uploadColumns.split(" ").length).toBe(1);
      await expect(page).toHaveURL(`/investigations/${caseId}/situation`);
      run.record(requirement, observed.join("; "));
    }

    expect(run.finish().evaluated.map((evidence) => evidence.id)).toEqual([...REFLOW_SLICE]);
  });

  test("reduced motion removes nonzero animation and transition durations from the visible strategy", async ({ page }) => {
    const run = new BrowserConformanceRun("Investigation First", REDUCED_MOTION_SLICE);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await expect(page.locator(".investigation-first")).toBeVisible();

    run.record("reduced-motion", await expectReducedMotion(page, strategyRoot(page)));
    expect(run.finish().evaluated.map((evidence) => evidence.id)).toEqual([...REDUCED_MOTION_SLICE]);
  });

  test("forced colors retains system control boundaries and a visible keyboard focus indicator", async ({ page }) => {
    const run = new BrowserConformanceRun("Investigation First", FORCED_COLORS_SLICE);
    await page.emulateMedia({ forcedColors: "active" });
    await page.reload();
    await expect(page.locator(".investigation-first")).toBeVisible();

    run.record(
      "forced-colors",
      await expectForcedColors(page, [
        page.getByLabel("What should the team call this?"),
        page.getByLabel("Severity"),
        page.getByRole("button", { name: "Create investigation" }),
      ]),
    );
    expect(run.finish().evaluated.map((evidence) => evidence.id)).toEqual([...FORCED_COLORS_SLICE]);
  });
});

test.describe("Investigation First browser conformance coverage", () => {
  test("claims every browser-surface requirement the shared profile declares", () => {
    assertProfileParity();
    assertBrowserSurfaceCovered([
      KEYBOARD_SLICE,
      REFLOW_SLICE,
      REDUCED_MOTION_SLICE,
      FORCED_COLORS_SLICE,
    ]);
  });
});
