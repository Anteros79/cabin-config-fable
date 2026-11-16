import { expect, test } from "./fixtures.ts";
import { lookup, openMap, recordPrimary, selectLocation, waitFor3D } from "./helpers.ts";

test("no Content-Security-Policy violation during the workflow", async ({ page }) => {
  // every violation the page reports, from the first script on
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (e) => seen.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
  });
  const violations = () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
  await page.goto("/#/check");
  await lookup(page, "N100TL", "2026-11-12");
  await page.getByRole("button", { name: "Start visit (saves a draft)" }).click();
  await expect(page.locator("#work-h")).toBeVisible();
  await waitFor3D(page); // the scene: WebGL, textures, workers and inline style attributes
  await page.getByRole("button", { name: "Got it" }).click();
  await openMap(page);
  await selectLocation(page, "Seat 3A");
  await recordPrimary(page, "CUSHION");
  await page.getByRole("button", { name: "Complete visit…" }).click();
  await page.locator("dialog.confirm[open]").getByRole("button", { name: "Confirm completion" }).click();
  await expect(page.locator("#totals-table")).toBeVisible();
  expect(await violations()).toEqual([]);
  for (const hash of ["#/prep?tail=N100TL&date=2026-11-12", "#/visits", "#/layouts", "#/reference"]) {
    await page.goto(`/${hash}`);
    await expect(page.locator("main h2").first()).toBeVisible();
    expect(await violations(), `on ${hash}`).toEqual([]);
  }
});

test("security headers on the page and on a hashed asset", async ({ request }) => {
  const page = await request.get("/");
  expect(page.status()).toBe(200);
  const html = await page.text();
  const headers = page.headers();
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("script-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cache-control"]).toBe("no-store");

  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  if (!asset) throw new Error("no script asset in index.html");
  const res = await request.get(asset);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
});
