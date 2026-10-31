// Everleaf Park HUD: game-style controls, pet directory, 3-step planting popup and memorial close-up.
import { mountPark, yearsLabel, type ParkHandle, type ParkMemorial } from "./park-world.ts";
import type { User } from "./types.ts";
import { tileKind, type GlobalPlot } from "./park-grid.ts";

type Deps = {
  api<T = Record<string, unknown>>(path: string, method?: string, data?: unknown): Promise<T>;
  getUser(): User | null;
  setUser(u: User): void;
  isPreview(): boolean;
  go(path: string): void;
  toast(msg: string): void;
};
type FreePlot = GlobalPlot & { key: string; tile: string };
type ParkData = { stones: string[]; near: { i: number; j: number }; free: FreePlot[]; items: ParkMemorial[] };

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const SPECIES: [string, string, string][] = [
  ["dog", "Dog", "🐕"], ["cat", "Cat", "🐈"], ["rabbit", "Rabbit", "🐇"], ["bird", "Bird", "🐦"],
  ["guinea", "Guinea pig", "🐹"], ["horse", "Horse", "🐎"], ["turtle", "Turtle", "🐢"],
];
const STONES: [string, string, string][] = [
  ["classic", "Hearth", "Rounded and timeless"],
  ["arch", "Arbour", "A tall gentle arch"],
  ["heart", "Keepsake", "Heart-shaped stone"],
  ["leaf", "Everleaf", "Our leaf, carved in sage"],
];
const STONE_SVG: Record<string, string> = {
  classic: "M10 58V26a20 20 0 0 1 40 0v32z",
  arch: "M8 58V32Q8 6 30 4Q52 6 52 32v26z",
  heart: "M30 58C22 48 6 38 6 22C6 12 22 6 30 18C38 6 54 12 54 22C54 38 38 48 30 58z",
  leaf: "M30 58C8 46 8 20 30 4C52 20 52 46 30 58z",
};
const stoneIcon = (s: string) => `<svg viewBox="0 0 60 62" aria-hidden="true"><path d="${STONE_SVG[s]}" class="si-${s}"/><rect x="4" y="56" width="52" height="6" rx="2" class="si-base"/></svg>`;
const speciesLabel = (s: string) => SPECIES.find((x) => x[0] === s)?.[1] || s;
const speciesEmoji = (s: string) => SPECIES.find((x) => x[0] === s)?.[2] || "🐾";
const yearNow = new Date().getFullYear();
const years = (sel: number, min = 1980) =>
  Array.from({ length: yearNow - min + 1 }, (_, i) => yearNow - i).map((y) => `<option value="${y}"${y === sel ? " selected" : ""}>${y}</option>`).join("");

export type ParkUI = { show(id: string | null): void; destroy(): void };

export function mountParkUI(root: HTMLElement, deps: Deps, mode: { legacy?: boolean } = {}): ParkUI {
  root.className = "park-root";
  root.innerHTML = `
  <div class="park" id="park">
    <div class="park-stage" id="park-stage" data-ready="0"></div>
    <div class="hud hud-tl">
      <a class="hud-brand wood" href="#/" aria-label="Everleaf Park home">🍃 <span>Everleaf Park</span></a>
      <div class="hud-seg" role="group" aria-label="Camera view">
        <button class="seg on" data-view="overview" aria-pressed="true">🪶 Overview</button>
        <button class="seg" data-view="close" aria-pressed="false">🔍 Up close</button>
      </div>
      ${mode.legacy ? `<a class="hud-coords wood" href="#/">← Endless park</a>` : `<div class="hud-coords wood" id="hud-coords" aria-live="off" title="Your tile in the endless park">📍 <b>0, 0</b></div>`}
    </div>
    <div class="hud hud-tr">
      <div class="hud-clock wood"><span id="hud-sky">☀️</span><span><small id="hud-part">Daytime</small><b id="hud-time">--:--</b></span></div>
      <button class="hud-round wood" data-act="about" aria-label="About Everleaf">?</button>
      ${deps.getUser() ? `<a class="hud-round wood" href="#/home" aria-label="My memorials">👤</a>` : ""}
    </div>
    <p class="hud-hint" id="hud-hint">${mode.legacy ? "The original closed park · drag to look around" : "WASD / arrows to walk (shift runs) · drag to look · right-drag to pan · tap a stone to visit"}</p>
    <nav class="dock" aria-label="Park">
      <button class="dock-round" data-act="pets"><span class="dr-icon">📖</span><span>Pets</span></button>
      <button class="dock-main wood" data-act="create"${mode.legacy ? " hidden" : ""}>🌱 <span class="long">Plant a memorial</span><span class="short">Plant one</span></button>
      <button class="dock-round" data-act="plaza"><span class="dr-icon">⛲</span><span>Plaza</span></button>
    </nav>
    <aside class="drawer parchment" id="pets" hidden aria-label="Pets in the park">
      <header><h2>Friends in the park</h2><button class="x wood" data-act="close-pets" aria-label="Close">✕</button></header>
      <input class="search" id="pet-search" type="search" placeholder="Find a name…" aria-label="Find a pet by name">
      <ul id="pet-list"></ul>
    </aside>
    <section class="memorial-view" id="mv" hidden>
      <button class="mv-back wood" data-act="back">← Back to the park</button>
      <article class="mv-card parchment" id="mv-card" aria-live="polite"></article>
      <button class="mv-share wood" data-act="share">🔗 Share this memorial</button>
    </section>
    <div class="modal-wrap" id="create" hidden><div class="modal parchment" role="dialog" aria-modal="true" aria-labelledby="create-title"></div></div>
    <div class="modal-wrap" id="about" hidden><div class="modal parchment small" role="dialog" aria-modal="true">
      <h2>About Everleaf Park</h2><p>A shared garden where every much-loved pet has a stone of their own. Plant a memorial with a photo and a few words, choose a stone and a spot, and friends can visit, light a candle or leave a toy.</p>
      <div class="m-actions"><button class="btn-wood" data-act="close-about">Close</button></div></div></div>
  </div>`;
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const stage = $("#park-stage");
  let data: ParkData = { stones: [], near: { i: 0, j: 0 }, free: [], items: [] };
  let selected: string | null = null;
  let lastTile = "";
  const park: ParkHandle = mountPark(stage, {
    legacy: mode.legacy,
    onSelect: (id) => deps.go("/p/" + id),
    onMove: ({ i, j }) => {
      const k = `${i}, ${j}`;
      if (k === lastTile) return;
      lastTile = k;
      const el = root.querySelector("#hud-coords b");
      if (el) el.textContent = k + (tileKind(i, j) === "landmark" ? " · 🏮" : "");
    },
  });
  // Test/dev hook for verify scripts and screenshots: only in preview mode with ?test in the URL.
  if (deps.isPreview() && new URLSearchParams(location.search).has("test")) (stage as HTMLElement & { park?: ParkHandle }).park = park;

  // Clock: real local time, a gentle day-part label.
  const tickClock = () => {
    const d = new Date(), h = d.getHours();
    $("#hud-time").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const [sky, part] = h < 6 ? ["🌙", "Night"] : h < 11 ? ["🌤️", "Morning"] : h < 17 ? ["☀️", "Daytime"] : h < 20 ? ["🌇", "Evening"] : ["🌙", "Night"];
    $("#hud-sky").textContent = sky; $("#hud-part").textContent = part;
  };
  tickClock();
  const clockTimer = setInterval(tickClock, 30000);

  async function refresh() {
    const c = park.center();
    data = await deps.api<ParkData>(`/park?near=${c.i},${c.j}`);
    await park.setMemorials(data.items);
    renderList();
    if (selected) renderCard();
  }
  function renderList() {
    const q = $<HTMLInputElement>("#pet-search").value.trim().toLowerCase();
    const rows = data.items.filter((m) => m.name.toLowerCase().includes(q));
    $("#pet-list").innerHTML = rows.length
      ? rows.map((m) => `<li><button data-open="${m.id}">${m.portrait ? `<img src="${esc(m.portrait)}" alt="">` : `<span class="ph">${speciesEmoji(m.species)}</span>`}<span><b>${esc(m.name)}</b><small>${esc(speciesLabel(m.species))} · ${esc(yearsLabel(m))}</small></span></button></li>`).join("")
      : `<li class="empty">No one by that name yet.</li>`;
  }
  const visited = new Set<string>();
  function renderCard() {
    const m = data.items.find((x) => x.id === selected);
    const card = $("#mv-card");
    if (!m) { card.innerHTML = `<p>This memorial isn’t in the park.</p>`; return; }
    const age = Number(m.passed) - Number(m.born);
    card.innerHTML = `
      <div class="mv-head">${m.portrait ? `<img class="mv-photo" src="${esc(m.portrait)}" alt="Photo of ${esc(m.name)}">` : `<span class="mv-photo ph">${speciesEmoji(m.species)}</span>`}
        <div><h1>${esc(m.name)}</h1><p class="mv-meta">${esc(speciesLabel(m.species))}${Number.isFinite(age) && age > 0 ? ` · ${age} ${age === 1 ? "year" : "years"}` : ""} · ${esc(STONES.find((s) => s[0] === m.stone)?.[1] || "")} stone</p><p class="mv-years">${esc(yearsLabel(m))}</p></div></div>
      <div class="mv-actions"><button class="btn-wood green" data-act="light">🕯️ Light a candle · ${m.lights}</button><button class="btn-wood" data-act="toy">🧸 Leave a toy · ${m.toys}</button></div>
      <dl class="mv-stats"><div><dt>👣 ${m.visits}</dt><dd>visits</dd></div><div><dt>🕯️ ${m.lights}</dt><dd>candles lit</dd></div><div><dt>🧸 ${m.toys}</dt><dd>toys left</dd></div></dl>
      ${m.message ? `<h2>Their story</h2><p class="mv-story">${esc(m.message)}</p>` : ""}
      <p class="mv-foot">Plot ${m.plot.k + 1} on tile ${m.plot.i}, ${m.plot.j} · <a href="#/m/${m.id}">Full memorial page</a></p>`;
  }
  async function act(action: "visit" | "light" | "toy") {
    if (!selected) return;
    const id = selected;
    try {
      const r = await deps.api<ParkMemorial & { counted: boolean }>(`/park/${id}/${action}`, "POST", {});
      const i = data.items.findIndex((x) => x.id === id);
      if (i >= 0) data.items[i] = { ...data.items[i], ...r };
      if (action !== "visit") {
        deps.toast(r.counted ? (action === "light" ? "Your candle is glowing by their stone." : "You left a toy by their stone.") : "You’ve already done that today. Thank you for coming back.");
        await park.setMemorials(data.items);
        park.focus(id);
      }
      if (selected === id) renderCard();
    } catch (e) { deps.toast(e instanceof Error ? e.message : "That didn’t work. Try again."); }
  }

  // ----- create popup -----
  type Draft = { step: number; file: File | null; photo: string; name: string; species: string; born: number; passed: number; message: string; stone: string; plot: string | null; busy: boolean; error: string };
  let draft: Draft;
  const resetDraft = () => (draft = { step: 1, file: null, photo: "", name: "", species: "dog", born: yearNow - 10, passed: yearNow, message: "", stone: "classic", plot: null, busy: false, error: "" });
  resetDraft();
  function openCreate() { resetDraft(); tilePage = 0; $("#create").hidden = false; renderCreate(); }
  function closeCreate() { $("#create").hidden = true; if (draft.photo) URL.revokeObjectURL(draft.photo); }
  // Each tile kind has Garmin's plots.json (tile-local Blender x/y metres). The picker shows the
  // tile nearest the player that still has room, pre-picking the first free plot.
  const layouts = new Map<string, { k: number; x: number; y: number }[]>();
  for (const kind of ["base", "alt1", "alt2", "landmark"])
    void fetch(`/models/v2/parks/C/park_C_${kind}.plots.json`).then((r) => (r.ok ? r.json() : null)).then((d: { plots: { name: string; x: number; y: number }[] } | null) => {
      if (d?.plots?.length) layouts.set(kind, d.plots.map((r) => ({ k: Number(r.name.replace(/\D/g, "")), x: r.x, y: r.y })));
    }).catch(() => {});
  const gridLayout = (n: number) => Array.from({ length: n }, (_, k) => ({ k, x: [-6.1, -3.3, 3.3, 6.1][k % 4], y: [6.2, 3.2, -3.2, -6.2][Math.floor(k / 4) % 4] }));
  let tilePage = 0;
  function plotMap() {
    // Free plots come back spiralling out from the player (up to ~500 plots searched); page by tile.
    const tilesWithRoom = [...new Map(data.free.map((p) => [`${p.i},${p.j}`, p])).values()];
    if (tilePage >= tilesWithRoom.length) tilePage = 0;
    const first = tilesWithRoom[tilePage];
    if (!first) return `<p class="note">The park is full right now.</p>`;
    const kind = tileKind(first.i, first.j);
    const layout = layouts.get(kind) || gridLayout(kind === "landmark" ? 12 : 16);
    const free = new Set(data.free.map((p) => p.key));
    const byPlot = new Map(data.items.filter((m) => m.plot.i === first.i && m.plot.j === first.j).map((m) => [m.plot.k, m]));
    const pct = (v: number) => (50 + (v / 9) * 50).toFixed(2) + "%";
    return `<p class="note">Tile ${first.i}, ${first.j}${kind === "landmark" ? " · by the Lantern Tree" : ""}${tilesWithRoom.length > 1 ? ` · <button type="button" class="link-btn" data-act="next-tile">Another tile → (${tilePage + 1}/${tilesWithRoom.length})</button>` : ""}</p><div class="plot-map" role="group" aria-label="Choose a plot"><div class="pm-plaza">${kind === "landmark" ? "🏮" : "✚"}</div>${layout.map(({ k, x, y }) => {
      const key = `${first.i}:${first.j}:${k}`, m = byPlot.get(k), isFree = free.has(key);
      return `<button type="button" style="left:${pct(x)};top:${pct(-y)}" class="pm-plot${isFree ? " free" : " taken"}${draft.plot === key ? " picked" : ""}" ${isFree ? `data-plot="${key}" aria-label="Plot ${k + 1}, free"` : `disabled aria-label="Plot ${k + 1}${m ? ", " + esc(m.name) : ", taken"}"`}>${isFree ? k + 1 : m ? esc(m.name.slice(0, 1)) : "·"}</button>`;
    }).join("")}</div>`;
  }
  function renderCreate() {
    const d = draft, together = Math.max(0, d.passed - d.born);
    const stepper = ["Their story", "Stone", "A spot"].map((t, i) => `<li class="${d.step === i + 1 ? "on" : d.step > i + 1 ? "done" : ""}"><span>${i + 1}</span>${t}</li>`).join("");
    let body = "";
    if (d.step === 1)
      body = `
        <label class="drop${d.photo ? " has" : ""}" for="c-photo">${d.photo ? `<img src="${d.photo}" alt="Chosen photo">` : `<span class="drop-icon wood">📷</span><b>Add a photo</b><small>Tap to choose, or drop it here. A clear, front-on photo works best.</small>`}<input id="c-photo" type="file" accept="image/jpeg,image/png,image/webp" hidden></label>
        <div class="row2"><div class="f"><label for="c-name">Name <i>*</i></label><input id="c-name" maxlength="80" placeholder="e.g. Poppy" value="${esc(d.name)}"></div>
        <div class="f"><span class="lbl" id="sp-l">They were a…</span><div class="chips" role="radiogroup" aria-labelledby="sp-l">${SPECIES.map(([v, l]) => `<button type="button" role="radio" aria-checked="${d.species === v}" class="chip${d.species === v ? " on" : ""}" data-species="${v}">${l}</button>`).join("")}</div></div></div>
        <div class="f"><span class="lbl">Years together</span><div class="years"><select id="c-born" aria-label="Year they joined you">${years(d.born)}</select><span>→</span><select id="c-passed" aria-label="Year they passed">${years(d.passed)}</select></div>
        <p class="together">🍃 ${together === 0 ? "Less than a year together" : `${together} ${together === 1 ? "year" : "years"} together`}</p></div>
        <div class="f"><label for="c-msg">A few words (optional)</label><textarea id="c-msg" maxlength="500" rows="2" placeholder="What made them, them?">${esc(d.message)}</textarea></div>
        <p class="note">🌿 Once planted, the photo, name and words are shown in the park for every visitor.</p>`;
    else if (d.step === 2)
      body = `<div class="stones" role="radiogroup" aria-label="Gravestone style">${STONES.map(([v, l, s]) => `<button type="button" role="radio" aria-checked="${d.stone === v}" class="stone-opt${d.stone === v ? " on" : ""}" data-stone="${v}">${stoneIcon(v)}<b>${l}</b><small>${s}</small></button>`).join("")}</div>
        <div class="stone-preview">${stoneIcon(d.stone)}<div><b>${esc(d.name)}</b><span>${d.born} – ${d.passed}</span></div></div>`;
    else
      body = `<p class="lead">Pick a free spot. Lighter plots are open.</p>${plotMap()}<p class="note">${d.plot === null ? "No plot chosen yet." : `Plot ${Number(d.plot.split(":")[2]) + 1} chosen.`}</p>`;
    const next = d.step === 1 ? "Next: choose a stone →" : d.step === 2 ? "Next: choose a spot →" : d.busy ? "Planting…" : "🌱 Plant memorial";
    $("#create .modal").innerHTML = `
      <header class="m-head"><h2 id="create-title">Plant a memorial</h2><button class="x wood" data-act="close-create" aria-label="Close">✕</button></header>
      <ol class="stepper">${stepper}</ol>
      <div class="m-body">${body}</div>
      <p class="error" role="alert">${esc(d.error)}</p>
      <div class="m-actions"><button class="btn-wood ghost" data-act="${d.step === 1 ? "close-create" : "prev"}">${d.step === 1 ? "Cancel" : "← Back"}</button><button class="btn-wood main" data-act="next"${d.busy ? " disabled" : ""}>${next}</button></div>`;
    const file = root.querySelector<HTMLInputElement>("#c-photo");
    file?.addEventListener("change", () => file.files?.[0] && setPhoto(file.files[0]));
    const drop = root.querySelector<HTMLElement>(".drop");
    drop?.addEventListener("dragover", (e) => e.preventDefault());
    drop?.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f) setPhoto(f); });
  }
  function captureStep1() {
    const v = (s: string) => root.querySelector<HTMLInputElement>(s)?.value ?? "";
    if (draft.step !== 1) return;
    draft.name = v("#c-name").trim(); draft.message = v("#c-msg").trim();
    draft.born = Number(v("#c-born")) || draft.born; draft.passed = Number(v("#c-passed")) || draft.passed;
  }
  function setPhoto(f: File) {
    captureStep1();
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) { draft.error = "Choose a JPG, PNG or WebP photo."; return renderCreate(); }
    if (draft.photo) URL.revokeObjectURL(draft.photo);
    draft.file = f; draft.photo = URL.createObjectURL(f); draft.error = ""; renderCreate();
  }
  async function plant() {
    const d = draft;
    d.busy = true; d.error = ""; renderCreate();
    try {
      if (!deps.getUser()) {
        if (!deps.isPreview()) { closeCreate(); deps.go("/login?next=" + encodeURIComponent("/#/")); return; }
        const s = await deps.api<{ user: User }>("/preview/session", "POST", { name: "Keeper" });
        deps.setUser(s.user);
      }
      const base = { name: d.name, species: d.species, born: String(d.born), passed: String(d.passed), message: d.message, theme: "A", setting: "garden", style: "stylized", finish: "glaze", visibility: "public", review: false, arrangement: [] };
      const m = await deps.api<{ id: string }>("/memorials", "POST", base);
      const up = await fetch(`/api/memorials/${m.id}/media?purpose=portrait&zoom=1&x=0.5&y=0.5&filename=${encodeURIComponent(d.file!.name.slice(0, 140) || "Photo")}`, { method: "POST", headers: { "Content-Type": d.file!.type }, body: d.file! });
      if (!up.ok) throw Error((await up.json()).error || "The photo couldn’t be saved.");
      const c = park.center();
      await deps.api(`/park/${m.id}/place`, "POST", { plot: d.plot, near: `${c.i},${c.j}`, stone: d.stone });
      const full = await deps.api<{ version: number }>("/memorials/" + m.id);
      await deps.api("/memorials/" + m.id, "PATCH", { ...base, version: full.version, status: "published" });
      closeCreate();
      await refresh();
      deps.toast(`${d.name}’s stone is planted.`);
      deps.go("/p/" + m.id);
    } catch (e) {
      d.busy = false; d.error = e instanceof Error ? e.message : "Planting didn’t finish. Try again."; renderCreate();
      void refresh();
    }
  }
  function next() {
    captureStep1();
    const d = draft;
    if (d.step === 1) {
      if (!d.file) d.error = "Add a photo so their stone can show it.";
      else if (!d.name) d.error = "Add their name.";
      else if (d.born > d.passed) d.error = "The first year should come before the last.";
      else { d.error = ""; d.step = 2; }
    } else if (d.step === 2) { d.error = ""; d.step = 3; void refresh().then(() => { if (draft.plot === null && data.free[0]) draft.plot = data.free[0].key; renderCreate(); }); }
    else { if (d.plot === null) d.error = "Choose a free plot."; else return void plant(); }
    renderCreate();
  }

  // ----- events -----
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLElement>("[data-act],[data-open],[data-view],[data-species],[data-stone],[data-plot]");
    if (!btn) { if (t.classList.contains("modal-wrap")) { (t as HTMLElement).hidden = true; } return; }
    const a = btn.dataset;
    if (a.open) { $("#pets").hidden = true; deps.go("/p/" + a.open); return; }
    if (a.view) { deps.go("/"); setView(a.view as "overview" | "close"); return; }
    if (a.species) { captureStep1(); draft.species = a.species; renderCreate(); return; }
    if (a.stone) { draft.stone = a.stone; renderCreate(); return; }
    if (a.plot) { draft.plot = a.plot; draft.error = ""; renderCreate(); return; }
    switch (a.act) {
      case "pets": $("#pets").hidden = !$("#pets").hidden; if (!$("#pets").hidden) $("#pet-search").focus(); break;
      case "close-pets": $("#pets").hidden = true; break;
      case "create": openCreate(); break;
      case "close-create": closeCreate(); break;
      case "prev": draft.error = ""; draft.step--; renderCreate(); break;
      case "next": next(); break;
      case "next-tile": tilePage++; renderCreate(); break;
      case "plaza": deps.go("/"); setView("overview"); if (!mode.legacy) park.walkTo(0, -3); break;
      case "back": deps.go("/"); break;
      case "about": $("#about").hidden = false; break;
      case "close-about": $("#about").hidden = true; break;
      case "light": void act("light"); break;
      case "toy": void act("toy"); break;
      case "share": {
        const link = location.origin + "/#/p/" + selected;
        const m = data.items.find((x) => x.id === selected);
        (navigator.share ? navigator.share({ title: `${m?.name} · Everleaf Park`, url: link }) : navigator.clipboard.writeText(link).then(() => deps.toast("Link copied.")))
          .catch(() => deps.toast(link));
        break;
      }
    }
  });
  root.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (t.id === "pet-search") renderList();
    if (t.id === "c-born" || t.id === "c-passed") { captureStep1(); renderCreate(); }
  });
  root.addEventListener("change", (e) => { const t = e.target as HTMLElement; if (t.id === "c-born" || t.id === "c-passed") { captureStep1(); renderCreate(); } });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (!$("#create").hidden) closeCreate(); else if (!$("#pets").hidden) $("#pets").hidden = true; else if (selected) deps.go("/");
  };
  addEventListener("keydown", onKey);

  function setView(v: "overview" | "close") {
    root.querySelectorAll<HTMLElement>("[data-view]").forEach((b) => { b.classList.toggle("on", b.dataset.view === v); b.setAttribute("aria-pressed", String(b.dataset.view === v)); });
    park.setView(v);
  }
  const ready = refresh().catch((e) => deps.toast(e instanceof Error ? e.message : "The park couldn’t load."));

  return {
    show(id) {
      selected = id;
      $("#park").classList.toggle("viewing", Boolean(id));
      $("#mv").hidden = !id;
      if (!id) { park.focus(null); setView(park.view()); return; }
      void ready.then(() => {
        if (selected !== id) return;
        renderCard(); park.focus(id);
        if (!visited.has(id)) { visited.add(id); void act("visit"); }
      });
    },
    destroy() { clearInterval(clockTimer); removeEventListener("keydown", onKey); park.destroy(); },
  };
}
