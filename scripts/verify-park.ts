// Browser journey through the real park controls, without application test hooks.
import { chromium, type Page } from "playwright-core";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { verificationRuntime } from "./sites-verification.ts";
import { signInFixture } from "./sites-browser.ts";
const scratch = await mkdtemp(resolve(tmpdir(), "everleaf-park-"));
const out = resolve(
  process.env.BROWSER_EVIDENCE || "scratch/sites-park-evidence",
);
await mkdir(out, { recursive: true });
const port = await new Promise<number>((done) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const a = s.address();
    assert(a && typeof a === "object");
    s.close(() => done(a.port));
  });
});
const runtime = await verificationRuntime(scratch, port),
  origin = runtime.origin;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const errors: string[] = [],
  checks: string[] = [];
async function settle(p: Page) {
  await p.waitForSelector(
    '#park-stage[data-ready="1"][data-streaming="idle"]',
    { timeout: 120000 },
  );
}
async function ring(p: Page) {
  const state = await p
    .locator("#park-stage")
    .evaluate((el) => ({ ...(el as HTMLElement).dataset }));
  const [i, j] = state.center!.split(",").map(Number),
    tiles = new Set(state.tiles!.split(";"));
  for (let x = -2; x <= 2; x++)
    for (let y = -2; y <= 2; y++) assert(tiles.has(`${i + x},${j + y}`));
  for (const tile of tiles) {
    const [a, b] = tile.split(",").map(Number);
    assert(Math.max(Math.abs(a - i), Math.abs(b - j)) <= 3);
  }
  assert.equal(state.parkAsset, "glb");
  assert.equal(
    await p
      .locator("canvas.park-canvas")
      .evaluate((c) =>
        (c as HTMLCanvasElement).getContext("webgl2")!.getError(),
      ),
    0,
  );
}
try {
  await runtime.start();
  for (const [w, h] of [
    [1280, 800],
    [390, 844],
  ]) {
    const context = await browser.newContext({
      viewport: { width: w, height: h },
      hasTouch: w < 500,
      isMobile: w < 500,
    });
    const p = await context.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await signInFixture(p, origin, `park-${w}@example.test`, "Keeper", "/#/");
    await settle(p);
    await ring(p);
    assert.equal(
      await p.evaluate(
        () => typeof (document.getElementById("park-stage") as any).park,
      ),
      "undefined",
    );
    assert.equal(await p.locator(".site-header").count(), 0);
    if (w === 1280) {
      await p.locator(".park-canvas").focus();
      await p.keyboard.down("ShiftLeft");
      await p.keyboard.down("KeyD");
      try {
        await p.waitForFunction(
          () => document.getElementById("park-stage")!.dataset.center !== "0,0",
          null,
          { timeout: 60000 },
        );
      } finally {
        await p.keyboard.up("KeyD");
        await p.keyboard.up("ShiftLeft");
      }
      await settle(p);
      await ring(p);
      checks.push(
        "keyboard walk streams a complete tile ring and unloads distant tiles",
      );
      await p.click("[data-act=plaza]");
      await p.waitForFunction(
        () => document.getElementById("park-stage")!.dataset.center === "0,0",
      );
      await settle(p);
    }
    const before = Number(
      await p.getAttribute("#park-stage", "data-memorials"),
    );
    await p.click("[data-view=close]");
    assert.equal(await p.getAttribute("#park-stage", "data-view"), "close");
    await p.click("[data-view=overview]");
    await p.click("[data-act=create]");
    await p.click("[data-act=next]");
    assert.match(await p.locator("#create .error").innerText(), /photo/);
    await p.setInputFiles("#c-photo", resolve("public/assets/img/A0.jpg"));
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
    await p.waitForURL(/#\/p\//, { timeout: 60000 });
    await p.locator("#mv-card h1").filter({ hasText: name }).waitFor();
    const id = p.url().split("#/p/")[1];
    assert.equal(await p.getAttribute("#park-stage", "data-view"), "memorial");
    await p.click("[data-act=light]");
    await p.waitForSelector('[data-act=light]:has-text("· 1")');
    await p.click("[data-act=toy]");
    await p.waitForSelector('[data-act=toy]:has-text("· 1")');
    await p.screenshot({ path: resolve(out, `park-${w}.png`) });
    await p.click("[data-act=back]");
    await p.waitForURL(/#\/$/);
    await p.waitForFunction(
      (n) =>
        Number(document.getElementById("park-stage")?.dataset.memorials) ===
        n + 1,
      before,
    );
    await settle(p);
    await p.click("[data-act=pets]");
    await p.locator(`#pet-list [data-open="${id}"]`).click();
    await p.waitForURL(/#\/p\//);
    await p.locator("#mv-card h1").filter({ hasText: name }).waitFor();
    await p.reload();
    await settle(p);
    await p.locator("#mv-card h1").filter({ hasText: name }).waitFor();
    checks.push(
      `${w}px: real geometry, view controls, validated three-step planting, portrait, candle, toy, Pets navigation and persisted close-up`,
    );
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    "docs/verification-park.json",
    JSON.stringify(
      { status: "passed", checks, at: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ ok: true, checks }));
} catch (error) {
  for (const c of browser.contexts())
    for (const p of c.pages())
      await p.screenshot({ path: resolve(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await runtime.stop();
  await rm(scratch, { recursive: true, force: true });
}
