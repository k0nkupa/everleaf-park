// Browser journey for Everleaf Park against a running preview (default http://127.0.0.1:4881).
// Plants a memorial through the 3-step popup, opens its close-up, lights a candle and leaves a toy.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tileKind, tileOrigin, TILE_SIZE } from "../src/park-grid.ts";
const origin = process.env.ORIGIN || "http://127.0.0.1:4881";
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const errors: string[] = [], checks: string[] = [];
type Page = Awaited<ReturnType<typeof browser.newPage>>;
type Stats = { tiles: string[]; memorials: string[]; parsed: number; lights: number };
const LOAD_R = 2, DROP_R = 3;
const stats = (p: Page) => p.evaluate(() => (document.getElementById("park-stage") as any).park.stats() as Stats);
async function settle(p: Page, i: number, j: number) {
  await p.waitForFunction(
    ([c]) => { const d = document.getElementById("park-stage")!.dataset; return d.center === c && d.streaming === "idle"; },
    [`${i},${j}`], { timeout: 120000 },
  );
  await p.waitForTimeout(400); // let memorial builds on fresh tiles land
}
function assertRing(s: Stats, i: number, j: number) {
  const have = new Set(s.tiles);
  for (let di = -LOAD_R; di <= LOAD_R; di++) for (let dj = -LOAD_R; dj <= LOAD_R; dj++)
    assert.ok(have.has(`${i + di},${j + dj}`), `tile ${i + di},${j + dj} loaded around ${i},${j}`);
  for (const k of s.tiles) {
    const [a, b] = k.split(",").map(Number);
    assert.ok(Math.max(Math.abs(a - i), Math.abs(b - j)) <= DROP_R, `far tile ${k} unloaded (center ${i},${j})`);
  }
}
// Expected world spot of plot k on tile (i, j), from Garmin's plots.json (Blender x,y -> glTF x,-y).
function expectedPlot(i: number, j: number, k: number) {
  const json = JSON.parse(readFileSync(`public/models/v2/parks/C/park_C_${tileKind(i, j)}.plots.json`, "utf8"));
  const pl = json.plots.find((r: { name: string }) => r.name === `plot_${String(k).padStart(2, "0")}`);
  const o = tileOrigin(i, j);
  return { x: o.x + pl.x, z: o.z - pl.y };
}
async function infiniteWalk(p: Page) {
  const out: string[] = [];
  const park = await (await fetch(origin + "/api/park")).json() as { items: { id: string; plot: { i: number; j: number; k: number } }[] };
  await settle(p, 0, 0);
  let s = await stats(p);
  assertRing(s, 0, 0);
  assert.equal(s.parsed, 4, "each tile kind parsed once");
  assert.ok(s.lights >= 1 && s.lights <= 6, "lamp light pool is capped");
  const far = park.items.find((m) => Math.max(Math.abs(m.plot.i), Math.abs(m.plot.j)) > DROP_R);
  assert.ok(far, "a memorial sits on a far tile");
  assert.ok(!s.memorials.includes(far.id), "far memorial is not rendered while its tile is unloaded");
  // Dog material: soft, non-metallic, lifted from the near-black first pass.
  const dog = await p.evaluate(() => (document.getElementById("park-stage") as any).park.petLook("demo-biscuit"));
  assert.ok(dog && dog.metalness <= 0.05 && dog.roughness >= 0.6 && dog.luminance > 0.15, `dog reads warm + soft ${JSON.stringify(dog)}`);
  // Every species renders with two eyes (the first-pass sculptures have none; pet-face.ts adds them).
  const looks = await p.evaluate(() => { const k = (document.getElementById("park-stage") as any).park; return k.stats().memorials.map((id: string) => k.petLook(id)); });
  const bySpecies = new Map<string, number>();
  for (const l of looks) if (l) bySpecies.set(l.species, Math.min(bySpecies.get(l.species) ?? 99, l.eyes));
  for (const sp of ["dog", "cat", "rabbit", "bird", "guinea", "horse", "turtle"])
    assert.ok((bySpecies.get(sp) ?? 0) >= 2, `${sp} has eyes rendered (${bySpecies.get(sp) ?? "not shown"})`);
  out.push(`eyes: ${[...bySpecies].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  // Collision: walk north from the plaza into the Lantern Tree; we stop outside it and never overlap a collider.
  const H = "(document.getElementById('park-stage')).park";
  const step = (dx: number, dz: number) => p.evaluate(([a, b, h]) => (eval(h as string) as any).step(a, b), [dx, dz, H] as const);
  const clear = async () => {
    const r = await p.evaluate((h) => { const k = eval(h); const t = k.step(0, 0); return { t, cs: k.colliders(t.x, t.z) }; }, H);
    return Math.min(...r.cs.map((c: any) => Math.hypot(c.x - r.t.x, c.z - r.t.z) - c.r - 0.35));
  };
  let pos = await step(0, 0);
  for (let n = 0; n < 30; n++) pos = await step(0, 0.2);
  assert.ok(pos.z < -0.6, `Lantern Tree blocks the walk (z=${pos.z.toFixed(2)})`);
  assert.ok((await clear()) > -0.02, "player never overlaps a collider");
  const blockedZ = pos.z;
  for (let n = 0; n < 15; n++) pos = await step(0.2, 0.2);
  assert.ok(Math.abs(pos.x) > 0.5, `diagonal push slides along the obstacle (x=${pos.x.toFixed(2)}, z=${pos.z.toFixed(2)} from ${blockedZ.toFixed(2)})`);
  assert.ok((await clear()) > -0.02, "still clear after sliding");
  const st = await p.evaluate(() => (document.getElementById("park-stage") as any).park.where("demo-biscuit"));
  await p.evaluate(([x, z]) => (document.getElementById("park-stage") as any).park.walkTo(x, z, true), [st.x, st.z - 2.5]);
  for (let n = 0; n < 20; n++) pos = await step(0, 0.2);
  assert.ok(Math.hypot(pos.x - st.x, pos.z - st.z) >= 0.85 + 0.35 - 0.02, "stones block the player");
  out.push(`collision: Lantern Tree stops the walk at z=${blockedZ.toFixed(2)}, diagonal slides to x=${pos.x.toFixed(2)}, stones block; dog metalness ${dog.metalness}, roughness ${dog.roughness}, luminance ${dog.luminance.toFixed(2)}`);
  await p.evaluate(() => (document.getElementById("park-stage") as any).park.walkTo(0, -3, true));
  await settle(p, 0, 0);
  out.push(`start: ${s.tiles.length} tiles around 0,0, 4 tile kinds parsed, ${s.lights} lamp lights`);
  // Keyboard walk: hold W, the player leaves the start tile.
  await p.locator(".park-canvas").focus();
  await p.keyboard.down("ShiftLeft"); await p.keyboard.down("KeyW");
  await p.waitForFunction(() => document.getElementById("park-stage")!.dataset.center !== "0,0", null, { timeout: 60000 });
  await p.keyboard.up("KeyW"); await p.keyboard.up("ShiftLeft");
  out.push(`keyboard walk moved to tile ${await p.getAttribute("#park-stage", "data-center")}`);
  // Walk tile by tile to the far memorial's tile, checking load/unload at each step.
  let i = 0, j = 0;
  const path: [number, number][] = [];
  while (i !== far.plot.i || j !== far.plot.j) {
    if (i !== far.plot.i) i += Math.sign(far.plot.i - i); else j += Math.sign(far.plot.j - j);
    path.push([i, j]);
  }
  for (const [a, b] of path) {
    await p.evaluate(([x, z]) => (document.getElementById("park-stage") as any).park.walkTo(x, z), [a * TILE_SIZE, -b * TILE_SIZE]);
    await settle(p, a, b);
    assertRing(await stats(p), a, b);
  }
  s = await stats(p);
  assert.ok(!s.tiles.includes("0,0"), "origin tile unloaded after walking away");
  assert.ok(!s.memorials.includes("demo-biscuit"), "origin memorials unloaded with their tile");
  const at = await p.evaluate((id) => (document.getElementById("park-stage") as any).park.where(id), far.id);
  assert.ok(at, "far memorial rendered once its tile loads");
  const exp = expectedPlot(far.plot.i, far.plot.j, far.plot.k);
  assert.ok(Math.hypot(at.x - exp.x, at.z - exp.z) < 0.05, `far memorial on plot ${far.plot.i}:${far.plot.j}:${far.plot.k} (${at.x},${at.z} vs ${exp.x},${exp.z})`);
  for (const id of s.memorials) {
    const m = park.items.find((x) => x.id === id)!, w2 = await p.evaluate((x) => (document.getElementById("park-stage") as any).park.where(x), id);
    const e = expectedPlot(m.plot.i, m.plot.j, m.plot.k);
    assert.ok(Math.hypot(w2.x - e.x, w2.z - e.z) < 0.05, `${id} on its plot`);
  }
  out.push(`walked ${path.length} tiles to ${far.plot.i},${far.plot.j}: rings loaded, far tiles + origin memorials unloaded, ${far.id} on plot ${far.plot.i}:${far.plot.j}:${far.plot.k}`);
  // Back to the plaza (walks home and streams the origin back in).
  await p.click("[data-act=plaza]");
  await settle(p, 0, 0);
  assert.ok((await stats(p)).memorials.includes("demo-biscuit"), "origin memorials return");
  out.push("plaza button returns to 0,0 and origin memorials reload");
  return out;
}
try {
  {
    const p = await browser.newPage();
    await p.goto(origin + "/#/");
    await p.waitForSelector("#park-stage");
    assert.equal(await p.evaluate(() => typeof (document.getElementById("park-stage") as any).park), "undefined", "test hook hidden without ?test");
    checks.push("test hook only exposed with ?test in preview mode");
    await p.close();
  }
  for (const [w, h] of [[1280, 800], [390, 844]]) {
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(origin + "/?test=1#/");
    await p.waitForSelector('#park-stage[data-ready="1"]', { timeout: 120000 });
    if (w === 1280) checks.push(...(await infiniteWalk(p)));
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
