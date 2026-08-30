import { expect, test, type Locator, type Page } from "@playwright/test";
import { uniqueTitle, loginAs } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

const DESKTOP = { width: 1280, height: 900 };
// A 1,120 CSS-pixel desktop at 200% zoom exposes 560 effective CSS pixels.
const TWO_HUNDRED_PERCENT_EQUIVALENT = { width: 560, height: 900 };

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

async function documentWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, "expected a visible control with a layout box").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual((await page.viewportSize())!.width + 1);
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
    test.setTimeout(90_000);
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

    expect(
      await page.locator(".investigation-first [draggable=true]").count(),
      "a core Investigation First action unexpectedly requires a drag target",
    ).toBe(0);
  });

  test("reflows at a 200% desktop-zoom equivalent without page-level horizontal scroll", async ({ page }) => {
    const title = uniqueTitle("Investigation First reflow proof");
    const caseId = await createWithKeyboard(page, title);

    await activate(page.getByRole("button", { name: /Back to investigations/u }), page);
    await expect(page).toHaveURL("/investigations");

    await page.setViewportSize(TWO_HUNDRED_PERCENT_EQUIVALENT);
    expect(await documentWidth(page)).toBeLessThanOrEqual(TWO_HUNDRED_PERCENT_EQUIVALENT.width);
    const search = page.getByRole("searchbox", { name: "Search investigations" });
    const statusFilter = page.getByRole("combobox", { name: "Filter investigations by status" });
    const createTitle = page.getByLabel("What should the team call this?");
    const advanced = page.locator(".investigation-first__advanced > summary");
    const result = page.locator(".investigation-first__list-button").filter({ hasText: title });
    await expectInsideViewport(page, search);
    await expectInsideViewport(page, statusFilter);
    await expectInsideViewport(page, createTitle);
    await expectInsideViewport(page, advanced);
    await expectInsideViewport(page, result);

    await activate(result, page);
    await expect(page).toHaveURL(`/investigations/${caseId}/situation`);
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    expect(await documentWidth(page)).toBeLessThanOrEqual(TWO_HUNDRED_PERCENT_EQUIVALENT.width);
    await expectInsideViewport(page, page.getByRole("button", { name: /Back to investigations/u }));
    await expectInsideViewport(page, page.getByRole("button", { name: "Open War Room technical tools" }));
    await expectInsideViewport(page, page.getByRole("button", { name: "Add to evidence inventory" }));
    await expectInsideViewport(page, page.getByRole("button", { name: "Archive investigation" }));

    const uploadColumns = await page.locator(".investigation-first__upload-grid").evaluate((node) =>
      getComputedStyle(node).gridTemplateColumns,
    );
    expect(uploadColumns.split(" ").length).toBe(1);
    await expect(page).toHaveURL(`/investigations/${caseId}/situation`);
  });

  test("reduced motion removes nonzero animation and transition durations from the visible strategy", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await expect(page.locator(".investigation-first")).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    const motionAudit = await page.locator(".investigation-first").evaluate((root) => {
      const durationIsNonzero = (value: string) => value.split(",").some((part) => {
        const duration = part.trim();
        return duration.endsWith("ms")
          ? Number.parseFloat(duration) !== 0
          : duration.endsWith("s") && Number.parseFloat(duration) !== 0;
      });
      const visible = [root, ...Array.from(root.querySelectorAll("*"))].filter((node) => {
        const element = node as HTMLElement;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      });
      return {
        inspected: visible.length,
        offenders: visible.flatMap((node) => {
          const style = getComputedStyle(node);
          return durationIsNonzero(style.animationDuration) || durationIsNonzero(style.transitionDuration)
            ? [{
                animationDuration: style.animationDuration,
                element: (node as HTMLElement).outerHTML.slice(0, 160),
                transitionDuration: style.transitionDuration,
              }]
            : [];
        }),
      };
    });
    expect(motionAudit.inspected).toBeGreaterThan(20);
    expect(motionAudit.offenders).toEqual([]);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  });

  test("forced colors retains system control boundaries and a visible keyboard focus indicator", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.reload();
    await expect(page.locator(".investigation-first")).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);

    const controls = [
      page.getByLabel("What should the team call this?"),
      page.getByLabel("Severity"),
      page.getByRole("button", { name: "Create investigation" }),
    ];
    for (const control of controls) {
      const boundary = await control.evaluate((node) => {
        const style = getComputedStyle(node);
        return { borderStyle: style.borderStyle, borderWidth: style.borderWidth };
      });
      expect(boundary.borderStyle).not.toBe("none");
      expect(Number.parseFloat(boundary.borderWidth)).toBeGreaterThan(0);
    }

    const create = controls[2]!;
    await create.focus();
    await expect(create).toBeFocused();
    const focus = await create.evaluate((node) => {
      const style = getComputedStyle(node);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(focus.outlineStyle).not.toBe("none");
    expect(Number.parseFloat(focus.outlineWidth)).toBeGreaterThan(0);
  });
});
