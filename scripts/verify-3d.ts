import { chromium, type Page } from "playwright-core";
import { verificationRuntime } from "./sites-verification.ts";
import { signInFixture } from "./sites-browser.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import sharp from "sharp";
const scratch = await mkdtemp(resolve(tmpdir(), "everleaf-3d-"));
const out = resolve(process.env.BROWSER_EVIDENCE || "../../work/preview-3d");
await mkdir(out, { recursive: true });
const port = await new Promise<number>((done) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const a = s.address();
    assert(a && typeof a === "object");
    s.close(() => done(a.port));
  });
});
const origin = `http://127.0.0.1:${port}`,
  checks: string[] = [],
  errors: string[] = [],
  models = new Set<string>();
let logs = "",
  emailRequests = 0;
function check(message: string) {
  checks.push(message);
  console.log("PASS", message);
}
const runtime = await verificationRuntime(scratch, port);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
async function page() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const p = await context.newPage();
  p.setDefaultTimeout(30000);
  p.setDefaultNavigationTimeout(30000);
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (msg) => {
    if (/WebGL|INVALID|Shader|buffer/i.test(msg.text()))
      console.log("BROWSER", msg.text());
    if (
      (msg.type() === "error" &&
        !(
          msg.text().includes("404") &&
          msg.location().url.includes("/api/memorials/")
        )) ||
      /GL_INVALID|WebGLProgram.*Error/.test(msg.text())
    )
      errors.push(msg.text());
  });
  p.on("request", (r) => {
    if (r.url().includes("api.resend.com")) emailRequests++;
  });
  p.on("response", (r) => {
    if (r.url().endsWith(".glb") && r.ok())
      models.add(new URL(r.url()).pathname);
  });
  p.on("dialog", (d) => void d.accept());
  return p;
}
async function ready(p: Page) {
  await p.waitForFunction(
    () => {
      const world = document.getElementById("world");
      return (
        world?.dataset.ready === "true" &&
        document.body.dataset.route ===
          (location.hash.slice(2).split(/[?\/]/)[0] || "village") &&
        Number(world.dataset.triangles) > 1000
      );
    },
    {},
    { timeout: 60000 },
  );
  await p.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  assert(
    Number(await p.locator("#world").getAttribute("data-triangles")) > 1000,
  );
  assert(
    Number(await p.locator("#world").getAttribute("data-draw-calls")) < 500,
  );
  assert.equal(
    await p
      .locator("canvas.world-canvas")
      .evaluate((c) =>
        (c as HTMLCanvasElement).getContext("webgl2")!.getError(),
      ),
    0,
    "WebGL must draw without GPU errors",
  );
}
async function shot(p: Page, name: string) {
  await ready(p);
  const image = await p.locator("canvas.world-canvas").screenshot();
  const pixels = await sharp(image)
    .resize(96, 64)
    .removeAlpha()
    .raw()
    .toBuffer();
  const theme =
    (await p.locator("#app").getAttribute("class"))?.match(/t-([ABC])/)?.[1] ||
    "A";
  const sky = (
    { A: [232, 198, 162], B: [181, 216, 227], C: [23, 38, 63] } as Record<
      string,
      number[]
    >
  )[theme];
  let visible = 0;
  for (let i = 0; i < pixels.length; i += 3)
    if (
      Math.abs(pixels[i] - sky[0]) +
        Math.abs(pixels[i + 1] - sky[1]) +
        Math.abs(pixels[i + 2] - sky[2]) >
      50
    )
      visible++;
  assert(
    visible / (96 * 64) > 0.3,
    name + " must visibly render its environment, not only a background",
  );
  await p.screenshot({
    path: resolve(out, name + ".png"),
    fullPage: true,
    animations: "disabled",
  });
  assert(
    await p.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
}
async function walk(p: Page) {
  await p.locator("canvas.world-canvas").focus();
  const before = await p.locator("#world").getAttribute("data-position"),
    camera = await p.locator("#world").getAttribute("data-camera");
  for (const key of ["w", "a", "s", "d"]) {
    await p.keyboard.down(key);
    try {
      await p.waitForFunction(
        (b) => document.getElementById("world")?.dataset.position !== b,
        before,
        { timeout: 2000 },
      );
    } catch {
    } finally {
      await p.keyboard.up(key);
    }
    if ((await p.locator("#world").getAttribute("data-position")) !== before)
      break;
  }
  assert.notEqual(
    await p.locator("#world").getAttribute("data-position"),
    before,
    "walking must move the visitor",
  );
  assert.notEqual(
    await p.locator("#world").getAttribute("data-camera"),
    camera,
    "camera must follow walking",
  );
}
async function patch(p: Page, id: string, values: Record<string, unknown>) {
  const m = await (await p.request.get(origin + "/api/memorials/" + id)).json();
  const r = await p.request.patch(origin + "/api/memorials/" + id, {
    headers: { Origin: origin },
    data: { ...m, ...values },
  });
  assert(r.ok(), await r.text());
  return r.json();
}
try {
  await runtime.start();
  const owner = await page();
  await owner.goto(origin + "/#/village");
  await ready(owner);
  const session = await (
    await owner.request.get(origin + "/api/session")
  ).json();
  assert.equal(session.preview, false);
  assert.equal(session.emailConfigured, false);
  assert.equal(session.user, null);
  await shot(owner, "01-village");
  await owner.keyboard.down("w");
  await owner.waitForFunction(
    () => {
      const p = document
        .getElementById("world")
        ?.dataset.position?.split(",")
        .map(Number);
      return p && p[1] < 1.3;
    },
    {},
    { timeout: 10000 },
  );
  await owner.waitForTimeout(350);
  const stopped = await owner.locator("#world").getAttribute("data-position");
  await owner.waitForTimeout(350);
  await owner.keyboard.up("w");
  assert.equal(
    await owner.locator("#world").getAttribute("data-position"),
    stopped,
    "the fountain must block walking",
  );
  await owner
    .getByRole("button", { name: "Return to entrance", exact: true })
    .click();
  await owner.waitForFunction(
    () => document.getElementById("world")?.dataset.position === "0.000,7.000",
  );
  check(
    "fountain collision blocks the visitor; reset restores the entrance and camera",
  );

  await walk(owner);
  await shot(owner, "02-walking");
  const canvas = owner.locator("canvas.world-canvas"),
    box = (await canvas.boundingBox())!;
  const camera = await owner.locator("#world").getAttribute("data-camera");
  await owner.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6);
  await owner.mouse.down();
  await owner.mouse.move(
    box.x + box.width * 0.65 + 100,
    box.y + box.height * 0.6 + 25,
    { steps: 12 },
  );
  await owner.mouse.up();
  assert.notEqual(
    await owner.locator("#world").getAttribute("data-camera"),
    camera,
  );
  check(
    "supplied village renders in WebGL; keyboard walking and pointer orbit change the actual camera",
  );
  await signInFixture(owner, origin, "owner@example.test", "Jamie");
  await owner
    .locator("header")
    .getByRole("link", { name: "Create a memorial", exact: true })
    .click();
  await owner.getByLabel("Their name").fill("Biscuit");
  await owner.getByLabel("Born (year or date)").fill("2011");
  await owner.getByLabel("Passed (year or date)").fill("2025");
  await owner
    .getByLabel("A short remembrance")
    .fill("Every muddy walk, kept close.");
  await owner
    .getByRole("button", { name: "Save draft and add photos" })
    .click();
  await owner.waitForURL(/\/photos$/);
  const id = owner.url().match(/edit\/([^/]+)\//)![1];
  let record = await (
    await owner.request.get(origin + "/api/memorials/" + id)
  ).json();
  // Draft allocation is stable even before publication.
  assert.ok(Number.isInteger(record.plot_index) && record.plot_index >= 0);
  assert.equal(record.status, "draft");
  check("Sites identity saves a private draft with a stable plot");
  await owner
    .getByLabel("Add or replace portrait")
    .setInputFiles(resolve("public/assets/img/A0.jpg"));
  await owner.locator("#crop-canvas").waitFor();
  await owner
    .getByRole("button", { name: "Save portrait", exact: true })
    .click();
  await owner.locator("img.portrait-large").waitFor();
  await owner.getByRole("link", { name: "Continue to sculpture" }).click();
  await owner.locator("input[name=style][value=stylized]").check();
  await owner
    .getByLabel("Finish for the stylized sculpture")
    .selectOption("bronze");
  await owner.getByRole("button", { name: "Save and continue" }).click();
  await owner.locator("input[name=theme][value=A]").check();
  await owner.locator("input[name=setting][value=house]").check();
  await owner.getByRole("button", { name: "Save and continue" }).click();
  await ready(owner);
  await owner.locator("[data-kind=Flowers]").click();
  await owner.locator('[data-place="0"]').focus();
  await owner.locator('[data-place="0"]').press("ArrowRight");
  await owner.getByRole("button", { name: "Save arrangement" }).click();
  await owner.getByRole("link", { name: "Preview & publish" }).click();
  await owner.locator("input[name=visibility][value=public]").check();
  await owner
    .getByRole("button", { name: "Publish memorial", exact: true })
    .click();
  await owner.waitForURL(new RegExp("/m/"+id+"$"));
  await owner.goto(origin+"/#/village?focus="+id);
  await ready(owner);
  assert.equal(
    await owner.locator("[data-selection-name]").textContent(),
    "Biscuit",
  );
  await shot(owner, "03-created-plot");
  await owner
    .getByRole("button", { name: "Enter Memory House", exact: true })
    .click();
  await owner.waitForURL(new RegExp("/m/" + id + "$"));
  await ready(owner);
  const view = owner.locator("canvas.world-canvas"),
    viewport = (await view.boundingBox())!,
    oldCamera = await owner.locator("#world").getAttribute("data-camera");
  await owner.mouse.move(
    viewport.x + viewport.width * 0.7,
    viewport.y + viewport.height * 0.4,
  );
  await owner.mouse.down();
  await owner.mouse.move(
    viewport.x + viewport.width * 0.7 + 70,
    viewport.y + viewport.height * 0.4 + 20,
    { steps: 8 },
  );
  await owner.mouse.up();
  assert.notEqual(
    await owner.locator("#world").getAttribute("data-camera"),
    oldCamera,
    "drag must turn the memorial camera",
  );
  const zoomBefore = await view.screenshot();
  await owner.mouse.wheel(0, -250);
  await owner.waitForTimeout(150);
  assert.notDeepEqual(
    await view.screenshot(),
    zoomBefore,
    "wheel must change the rendered zoom",
  );
  await owner
    .getByRole("button", { name: "Return to entrance", exact: true })
    .click();
  check(
    "memorial drag-look and mouse-wheel zoom change the actual rendered view",
  );
  await walk(owner);
  await shot(owner, "04-entered-house");
  record = await (
    await owner.request.get(origin + "/api/memorials/" + id)
  ).json();
  // Draft allocation is stable even before publication.
  assert.ok(Number.isInteger(record.plot_index) && record.plot_index >= 0);
  assert.equal(record.arrangement[0].x, 51);
  assert(record.portrait);
  check(
    "actual portrait upload, saved sculpture/finish, 3D keepsake arrangement, publish, named village plot and entering the house through UI",
  );
  await owner.goto(origin + "/#/village");
  await ready(owner);
  await owner.reload();
  await ready(owner);
  const records = JSON.parse(
    (await owner.locator("#world").getAttribute("data-records"))!,
  );
  assert.equal(
    records.find((m: { id: string }) => m.id === id).plot_index,
    record.plot_index,
  );
  await owner
    .getByRole("button", { name: "Return to entrance", exact: true })
    .click();
  await owner.waitForFunction(
    () => document.getElementById("world")?.dataset.position === "0.000,7.000",
  );

  await owner
    .getByRole("button", { name: "Select Biscuit’s memorial", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Enter Memory House", exact: true })
    .click();
  await ready(owner);
  check(
    "created plot persists after reload and a real world marker opens its saved memorial",
  );
  const visitor = await page();
  await visitor.goto(origin + "/#/village");
  await ready(visitor);
  await visitor
    .getByRole("button", { name: "Select Biscuit’s memorial", exact: true })
    .click();
  await visitor
    .getByRole("button", { name: "Enter Memory House", exact: true })
    .click();
  await ready(visitor);
  check("anonymous visitor can select and enter the actual published memorial");
  // Each selection is saved through the live editor, then its Blender environment is loaded.
  for (const theme of ["A", "B", "C"])
    for (const setting of ["house", "garden"]) {
      await owner.goto(origin + `/#/edit/${id}/setting`);
      await owner.locator(`input[name=theme][value=${theme}]`).check();
      await owner.locator(`input[name=setting][value=${setting}]`).check();
      await owner.getByRole("button", { name: "Save and continue" }).click();
      await ready(owner);
      await owner.goto(origin + "/#/m/" + id);
      await ready(owner);
      await walk(owner);
      await shot(owner, `scene-${theme}-${setting}`);
      const saved = await (
        await owner.request.get(origin + "/api/memorials/" + id)
      ).json();
      assert.equal(saved.theme, theme);
      assert.equal(saved.setting, setting);
      assert(models.has(`/models/${theme}_${setting}.glb`));
    }
  check(
    "all six supplied house/garden/theme environments save, load as live geometry and allow walking",
  );
  for (const style of ["stylized", "photo"]) {
    await owner.goto(origin + `/#/edit/${id}/sculpture`);
    await owner.locator(`input[name=style][value=${style}]`).check();
    await owner.getByRole("button", { name: "Save and continue" }).click();
    await owner.waitForURL(/\/setting$/);
    await owner.goto(origin + "/#/inspect/" + id);
    await ready(owner);
    await shot(owner, "dog-" + style);
    assert(models.has("/models/pet_dog_" + style + ".glb"));
  }
  for (const species of [
    "cat",
    "rabbit",
    "bird",
    "guinea",
    "horse",
    "turtle",
  ]) {
    await owner.goto(origin + `/#/edit/${id}/details`);
    await owner.getByLabel("Species", { exact: true }).selectOption(species);
    await owner.getByRole("button", { name: "Save and continue" }).click();
    await owner.waitForURL(/\/photos$/);
    await owner.goto(origin + "/#/m/" + id);
    await ready(owner);
    assert(models.has("/models/pet_" + species + ".glb"));
  }
  check(
    "both supplied dog sculpture shapes and six other species extracted from the village load in the actual memorial",
  );
  await patch(owner, id, {
    species: "dog",
    style: "photo",
    visibility: "private",
  });
  await visitor.goto(origin + "/#/m/" + id);
  await visitor.reload();
  await visitor
    .getByRole("heading", { name: "This place is not available." })
    .waitFor();
  await visitor.goto(origin + "/#/village");
  await ready(visitor);
  assert.equal(
    await visitor
      .getByRole("button", { name: "Select Biscuit’s memorial", exact: true })
      .count(),
    0,
  );
  await owner.goto(origin + "/#/m/" + id);
  await owner.reload();
  await ready(owner);
  check(
    "private memorial remains enterable by its keeper and absent from anonymous village and direct access",
  );
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(origin + "/#/village");
  await ready(owner);
  await shot(owner, "mobile-village");
  const before = await owner.locator("#world").getAttribute("data-position");
  const forward = owner.getByRole("button", {
    name: "Move forward",
    exact: true,
  });
  await forward.hover();
  await owner.mouse.down();
  await owner.waitForFunction(
    (p) => document.getElementById("world")?.dataset.position !== p,
    before,
  );
  await owner.mouse.up();
  await owner.goto(origin + "/#/m/" + id);
  await ready(owner);
  await shot(owner, "mobile-memorial");
  check(
    "phone layout renders live village and memorial with working on-screen movement controls and no horizontal overflow",
  );
  await owner.setViewportSize({ width: 1440, height: 1000 });
  await owner.goto(origin + "/#/settings/" + id);
  await owner
    .getByRole("button", { name: "Archive memorial", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Restore and review", exact: true })
    .waitFor();
  const paused = await owner.request.post(
    origin + `/api/memorials/${id}/candles`,
    {
      headers: { Origin: origin },
      data: { anonymous: true, message: "Paused" },
    },
  );
  assert.equal(paused.status(), 403);
  await owner
    .getByRole("button", { name: "Restore and review", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Publish memorial", exact: true })
    .waitFor();
  check(
    "existing archive protections and visibility review remain in force in the 3D preview",
  );
  const db = await runtime.mf.getD1Database("DB");
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM mail").first<{ n: number }>())!.n,
    0,
  );
  assert.equal(emailRequests, 0);
  assert.deepEqual(errors, []);
  const result = {
    status: "passed",
    checks,
    modelsLoaded: [...models],
    pageErrors: errors,
    emailsSent: 0,
    emailQueue: 0,
    isolatedDatabase: true,
  };
  await writeFile(
    resolve(out, "verification-3d.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      checks: checks.length,
      modelsLoaded: models.size,
      emailsSent: 0,
      evidence: out,
    }),
  );
} catch (error) {
  console.error(error);
  console.error(logs);
  for (const [i, c] of browser.contexts().entries())
    for (const p of c.pages())
      await p
        .screenshot({
          path: resolve(out, "failure-" + i + ".png"),
          fullPage: true,
        })
        .catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await runtime.stop();
  await rm(scratch, { recursive: true, force: true });
}
