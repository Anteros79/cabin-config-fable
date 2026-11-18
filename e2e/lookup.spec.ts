import { expect, test } from "./fixtures.ts";
import { lookup, openMap, recordPrimary, selectLocation, setDate, startVisitUi } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/#/check");
  await expect(page.locator("input[name=tail]")).toBeVisible();
});

for (const [tail, date, expected] of [
  ["N999ZZ", "2026-11-12", "UNKNOWN_TAIL"],
  ["N000TL", "2026-11-12", "UNCONFIGURED"],
  ["N500TL", "2026-03-01", "UNCONFIGURED"],
  ["N400TL", "2026-09-15", "OVERLAP"],
  ["N110TL", "2026-11-12", "PLANNED"],
  ["N600TL", "2026-03-01", "SOURCE_INVALID"],
  ["N090TL", "2026-11-12", "PARTIAL"],
  ["N200TL", "2026-06-30", "RESOLVED"],
  ["N200TL", "2026-07-01", "RESOLVED"],
] as const) {
  test(`${tail} ${date} shows ${expected}`, async ({ page }) => {
    expect(await lookup(page, tail, date)).toBe(expected);
    // a visit can start only from a resolved configuration
    await expect(page.getByRole("button", { name: "Start visit (saves a draft)" })).toHaveCount(expected === "RESOLVED" || expected === "PARTIAL" ? 1 : 0);
  });
}

test("N200TL retrofit boundary shows V05 then V04", async ({ page }) => {
  await lookup(page, "N200TL", "2026-06-30");
  await expect(page.locator(".panel.config")).toContainText("V05");
  await lookup(page, "N200TL", "2026-07-01");
  await expect(page.locator(".panel.config")).toContainText("V04");
});

test("empty tail is reported as invalid input, not a guess", async ({ page }) => {
  await page.locator("input[name=tail]").fill("");
  await page.locator("form.lookup-form button[type=submit]").click();
  await expect(page.locator(".status-card[data-state=INVALID_INPUT]")).toBeVisible();
});

test("the URL carries tail and date, and Back restores the earlier result", async ({ page }) => {
  await lookup(page, "N200TL", "2026-06-30");
  await expect(page).toHaveURL(/#\/check\?tail=N200TL&date=2026-06-30$/);
  await lookup(page, "N400TL", "2026-09-15");
  await expect(page).toHaveURL(/#\/check\?tail=N400TL&date=2026-09-15$/);
  await expect(page.locator(".status-card")).toHaveAttribute("data-state", "OVERLAP");
  await page.goBack();
  await expect(page).toHaveURL(/#\/check\?tail=N200TL&date=2026-06-30$/);
  await expect(page.locator(".status-card")).toHaveAttribute("data-state", "RESOLVED");
  await expect(page.locator(".panel.config")).toContainText("V05");
  await expect(page.locator("input[name=tail]")).toHaveValue("N200TL");
  await expect(page.getByLabel(/check date/i)).toHaveValue("2026-06-30");
  // a reload of the URL runs the same lookup
  await page.reload();
  await expect(page.locator(".status-card")).toHaveAttribute("data-state", "RESOLVED");
});

test("PARTIAL visit: gaps are visible, cannot be recorded and stay in the report", async ({ page }) => {
  await startVisitUi(page, "N090TL", "2026-11-12", "Gap Tech");
  await openMap(page);
  await expect(page.locator(".viewer-counts")).toContainText("170 unresolved");
  await selectLocation(page, "Overhead bin L-01");
  const bin = page.locator(".component-card[data-component=BIN_DOOR]");
  await expect(bin).toContainText("No match");
  await expect(bin.locator(".record-form")).toHaveCount(0);
  await selectLocation(page, "Forward floor area");
  await expect(page.locator(".component-card[data-component=CARPET_PANEL]")).toContainText("Ambiguous");
  await selectLocation(page, "Seat 12A");
  await expect(page.locator(".component-card[data-component=BACKREST]")).toContainText("expired after 2025-12-31");
  await recordPrimary(page, "CUSHION");
  await page.getByRole("link", { name: "Preview report" }).click();
  await expect(page.locator("#r-gaps")).toContainText("170 components");
});

test("expired alternate is not offered on 2027-01-01 and the reason is shown", async ({ page }) => {
  await startVisitUi(page, "N100TL", "2027-01-01", "Expiry Tech");
  await openMap(page);
  await selectLocation(page, "Full cabin floor");
  const kit = page.locator(".component-card[data-component=CARPET_KIT]");
  await expect(kit.locator("input[type=radio]")).toHaveCount(1);
  await expect(kit).toContainText("Not available: FAKE-CK-2000");
  await expect(kit).toContainText("expired after 2026-12-31");
  // the last valid day still offers it
  await startVisitUi(page, "N100TL", "2026-12-31", "Expiry Tech");
  await openMap(page);
  await selectLocation(page, "Full cabin floor");
  await expect(page.locator(".component-card[data-component=CARPET_KIT] input[type=radio]")).toHaveCount(2);
});

test("pending change is an advisory and the rule stays usable", async ({ page }) => {
  await startVisitUi(page, "N200TL", "2026-07-01", "Pending Tech");
  await openMap(page);
  await selectLocation(page, "Full cabin floor");
  const kit = page.locator(".component-card[data-component=CARPET_KIT]");
  await expect(kit).toContainText("FAKE-CK-2002");
  await expect(kit).toContainText("Pending change (advisory)");
  await recordPrimary(page, "CARPET_KIT");
});

// The tail and "Go to location" inputs submit their own form on Enter (WebKit's datalist takes the first Enter otherwise).
// In Chromium that must not add a second submit to the browser's own.
test("Enter in the tail input and in Go to location submits each form exactly once", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as { submits: string[] };
    w.submits = [];
    document.addEventListener("submit", (e) => w.submits.push((e.target as HTMLFormElement).className), true);
  });
  const submits = () => page.evaluate(() => (window as unknown as { submits: string[] }).submits);
  await page.locator("input[name=tail]").fill("N100TL");
  await setDate(page, "2026-11-12");
  await page.locator("input[name=tail]").press("Enter");
  await expect(page.locator(".status-card[data-state=RESOLVED]")).toBeVisible();
  expect(await submits()).toEqual(["lookup-form"]);
  await page.getByRole("button", { name: "Start visit (saves a draft)" }).click();
  await expect(page.locator("#work-h")).toBeVisible();
  await openMap(page);
  await page.locator("#goto-input").fill("3A");
  await page.locator("#goto-input").press("Enter");
  await expect(page.locator("#inspector-heading")).toHaveText(/^Seat 3A/);
  await expect(page.locator(".goto [role=status]")).toHaveText("Selected Seat 3A.");
  expect(await submits()).toEqual(["lookup-form", "goto"]);
});
