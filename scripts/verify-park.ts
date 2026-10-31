// Browser journey for Everleaf Park against a running preview (default http://127.0.0.1:4881).
// Plants a memorial through the 3-step popup, opens its close-up, lights a candle and leaves a toy.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const origin = process.env.ORIGIN || "http://127.0.0.1:4881";
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const errors: string[] = [], checks: string[] = [];
try {
  for (const [w, h] of [[1280, 800], [390, 844]]) {
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(origin + "/#/");
    await p.waitForSelector('#park-stage[data-ready="1"]', { timeout: 120000 });
    const before = Number(await p.getAttribute("#park-stage", "data-memorials"));
    assert.ok(before >= 1, "park shows seeded memorials");
    assert.equal(await p.locator(".site-header").count(), 0, "no website header in the park");
    await p.click("[data-act=pets]");
    assert.ok((await p.locator("#pet-list button").count()) >= 1);
    await p.click("[data-act=close-pets]");
    await p.click("[data-view=close]");
    assert.equal(await p.getAttribute("#park-stage", "data-view"), "close");
    await p.click("[data-view=overview]");
    await p.click("[data-act=create]");
    await p.click("[data-act=next]");
    assert.match(await p.locator("#create .error").innerText(), /photo/);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await p.setInputFiles("#c-photo", { name: "pet.png", mimeType: "image/png", buffer: png });
    const name = `Verify ${w}`;
    await p.fill("#c-name", name);
    await p.click("[data-species=rabbit]");
    await p.selectOption("#c-born", "2018");
    await p.selectOption("#c-passed", "2025");
    assert.match(await p.locator(".together").innerText(), /7 years together/);
    await p.click("[data-act=next]");
    await p.click("[data-stone=heart]");
    await p.click("[data-act=next]");
    await p.locator(".pm-plot.free").first().click();
    await p.click("[data-act=next]");
    await p.waitForFunction(() => location.hash.startsWith("#/p/"), null, { timeout: 60000 });
    await p.waitForSelector(`#mv-card h1:text-is("${name}")`);
    assert.equal(await p.getAttribute("#park-stage", "data-view"), "memorial");
    await p.click("[data-act=light]");
    await p.waitForSelector('[data-act=light]:has-text("· 1")');
    await p.click("[data-act=toy]");
    await p.waitForSelector('[data-act=toy]:has-text("· 1")');
    await p.click("[data-act=back]");
    await p.waitForFunction(() => location.hash === "#/");
    await p.waitForFunction((n) => Number(document.getElementById("park-stage")?.dataset.memorials) === n + 1, before);
    checks.push(`${w}px: park, pets list, view toggle, 3-step plant, close-up, candle, toy, back`);
    await p.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync("docs/verification-park.json", JSON.stringify({ origin, checks, at: new Date().toISOString() }, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await browser.close();
}
