import {
  canManage,
  THEMES,
  SPECIES,
  FINISHES,
  KEEPSAKES,
  type User,
  type Memorial,
  type Media,
  type Memory,
  type Member,
  type Report,
  type Placement,
} from "./types.ts";
import { mountWorld, type WorldHandle } from "./world.ts";
import { mountParkUI, type ParkUI } from "./park-ui.ts";
let park: ParkUI | null = null;
let parkLegacy = false;
let world: WorldHandle | null = null,
  preview = false;
const root = document.getElementById("app")!;
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
let user: User | null = null,
  current: Memorial | null = null,
  revision = 0,
  dirty = false,
  placement: Placement[] = [],
  noticeTimer: ReturnType<typeof setTimeout>;
const img = (m: Pick<Memorial, "species" | "style" | "finish">) =>
  `/assets/img/species/${m.species}_${m.style === "photo" ? "photo" : m.finish}.jpg`;
const backdrop = (m: Pick<Memorial, "theme" | "setting">) =>
  `/assets/img/${m.theme}_${m.setting}.jpg`;
const url = (path: string) => "#" + path;
const link = (label: string, path: string, cls = "btn") =>
  `<a class="${cls}" href="${esc(url(path))}">${label}</a>`;
const button = (label: string, action: string, cls = "btn", attrs = "") =>
  `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
function toast(message: string) {
  const e = document.getElementById("notice")!;
  e.textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (e.textContent = ""), 4500);
}
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
async function api<T = Record<string, unknown>>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const r = await fetch("/api" + path, {
    method,
    headers: data ? { "Content-Type": "application/json" } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const b = await r.json();
  if (!r.ok)
    throw new ApiError(
      r.status,
      b.error || "That action could not be completed.",
    );
  return b as T;
}
const header = (m?: Memorial) =>
  `<header class="site-header"><a class="brand" href="#/">Everleaf</a>${m ? `<span class="small desktop-only">${esc(m.name)} · ${m.setting === "house" ? "Memory House" : "Stillwater"}</span>` : ""}<nav class="site-nav">${link("Park", "/", "")}${user ? link("My memorials", "/home", "") : link("Sign in", "/login", "")}${link("Create a memorial", "/create", "btn p")}${user?.moderator ? link("Moderation", "/moderation", "") : ""}${user ? button("Sign out", "logout", "lnk") : ""}</nav></header>`;
const shell = (content: string, m?: Memorial) =>
  `<div class="site">${header(m)}${content}</div>`;
const field = (
  label: string,
  name: string,
  value: unknown = "",
  extra = "",
  type = "text",
) =>
  `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}></div>`;
const area = (label: string, name: string, value: unknown, extra = "") =>
  `<div class="field"><label for="${name}">${label}</label><textarea id="${name}" name="${name}" ${extra}>${esc(value)}</textarea></div>`;
const options = (obj: Record<string, string>, value: string) =>
  Object.entries(obj)
    .map(
      ([k, n]) =>
        `<option value="${k}" ${k === value ? "selected" : ""}>${esc(n)}</option>`,
    )
    .join("");
const errorBox = () => '<p class="error" role="alert" id="form-error"></p>';
const steps = [
  "details",
  "photos",
  "sculpture",
  "setting",
  "personalize",
  "publish",
];
const stepsUI = (m: Memorial, step: string) =>
  `<nav class="steps" aria-label="Creation progress">${steps.map((s, i) => link(`${i + 1}. ${s === "setting" ? "Setting & theme" : s[0].toUpperCase() + s.slice(1)}`, `/edit/${m.id}/${s}`, steps.indexOf(step) > i ? "done" : s === step ? "on" : "")).join("")}</nav>`;
const finishActions = (label = "Save and continue") =>
  `<div class="form-actions"><button class="btn p" type="submit">${label}</button></div>`;
const mayContribute = (m: Memorial) =>
  m.status !== "archived" &&
  m.role !== "viewer" &&
  (m.status === "published" || canManage(m));
const portrait = (m: Memorial, cls = "portrait-large") =>
  m.portrait
    ? `<img class="${cls}" src="${esc(m.portrait)}" alt="Portrait of ${esc(m.name)}">`
    : '<div class="empty small">Add their portrait to make this place theirs.</div>';
function authRequired() {
  if (user) return false;
  location.hash =
    "/login?next=" +
    encodeURIComponent("/#" + (location.hash.slice(1) || "/home"));
  return true;
}
const route = () => {
  const [p, q = ""] = (location.hash.slice(1) || "/").split("?");
  return {
    parts: p.split("/").filter(Boolean),
    query: new URLSearchParams(q),
    path: p,
  };
};
const go = (path: string) => {
  dirty = false;
  location.hash = path;
};
function formData(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form).entries()) as Record<
    string,
    string
  >;
}
function memorialBody(m: Memorial, overrides: Record<string, unknown> = {}) {
  return {
    name: m.name,
    species: m.species,
    born: m.born,
    passed: m.passed,
    message: m.message,
    theme: m.theme,
    setting: m.setting,
    style: m.style,
    finish: m.finish,
    visibility: m.visibility,
    review: m.review,
    arrangement: m.arrangement,
    version: m.version,
    ...overrides,
  };
}
const defaults = {
  name: "",
  species: "dog",
  born: "",
  passed: "",
  message: "",
  theme: "A",
  setting: "house",
  style: "stylized",
  finish: "glaze",
  visibility: "private",
  review: true,
  arrangement: [],
};
function detailsForm(m: Partial<Memorial> = {}) {
  return `${field("Their name", "name", m.name || "", 'required maxlength="80"')}<div class="field"><label for="species">Species</label><select id="species" name="species">${options(SPECIES, m.species || "dog")}</select></div><div class="two">${field("Born (year or date)", "born", m.born || "", 'maxlength="40" placeholder="Spring 2011"')}${field("Passed (year or date)", "passed", m.passed || "", 'maxlength="40" placeholder="Autumn 2025"')}</div>${area("A short remembrance", "message", m.message || "", 'maxlength="500"')}`;
}
function memorialCard(m: Memorial) {
  return `<article class="panel memorial-card t-${m.theme}"><img class="cover" src="${backdrop(m)}" alt="${esc(THEMES[m.theme].name)} ${m.setting === "house" ? "Memory House" : "Stillwater"}"><div class="copy">${m.portrait ? `<img class="portrait" src="${esc(m.portrait)}" alt="${esc(m.name)}">` : ""}<h2>${esc(m.name)}</h2><p class="small muted">${esc(SPECIES[m.species])} · ${esc([m.born, m.passed].filter(Boolean).join(" – "))}</p><p class="small">${esc(THEMES[m.theme].name)} · ${m.setting === "house" ? "Memory House" : "Stillwater"}</p>${m.status ? `<span class="badge">${esc(m.status)} · ${esc(m.visibility)}</span>` : ""}<div class="row">${link("Visit", `/m/${m.id}`, "btn p")}${canManage(m) ? link("Edit", `/edit/${m.id}/details`) : ""}${canManage(m) ? link("Settings", `/settings/${m.id}`) : ""}</div></div></article>`;
}
function worldFrame(scene: string, records: Memorial[] = [], focus = "") {
  return `<div class="world-view" id="world" data-scene="${scene}" data-records="${esc(JSON.stringify(records))}" data-focus="${esc(focus)}"><p class="world-status" role="status">Opening 3D…</p><div class="world-selection" hidden><div><strong data-selection-name></strong><p class="small">A place of their own.</p></div><button class="btn p" data-world-control="enter">Enter memorial</button><button class="world-close" aria-label="Close selected memorial" data-world-control="close">×</button></div><div class="world-tools"><button aria-label="Zoom in" title="Zoom in" data-world-control="zoom-in">+</button><button aria-label="Zoom out" title="Zoom out" data-world-control="zoom-out">−</button><button aria-label="Return to entrance" title="Return to entrance" data-world-control="reset">⌂</button></div>${scene === "sculpture" ? "" : `<div class="walk-pad" aria-label="Movement controls"><button data-walk-key="w" aria-label="Move forward">↑</button><button data-walk-key="a" aria-label="Move left">←</button><button data-walk-key="s" aria-label="Move backward">↓</button><button data-walk-key="d" aria-label="Move right">→</button></div>`}<p class="world-help">${scene === "sculpture" ? "Drag to turn · scroll to zoom" : "WASD / arrows to walk · drag to look · scroll to zoom"}<span>${scene === "sculpture" ? "Drag to turn. Use + and − to zoom." : "Tap the ground to walk. Tap a name to enter."}</span></p></div>`;
}
async function publicPage(query: URLSearchParams) {
  const q = query.get("q") || "",
    list = query.get("view") === "list",
    species = query.get("species") || "",
    theme = query.get("theme") || "";
  const { items } = await api<{ items: Memorial[] }>(
    `/memorials?q=${encodeURIComponent(q)}&species=${species}&theme=${theme}`,
  );
  const search = `<form id="search-form" class="search-form"><label class="small" for="q">Find a pet</label><input id="q" name="q" value="${esc(q)}" placeholder="Pet name"><select name="species" aria-label="Filter species"><option value="">All species</option>${options(SPECIES, species)}</select><select name="theme" aria-label="Filter theme"><option value="">All themes</option>${options(Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, v.name])), theme)}</select><button class="btn p">Search</button></form>`;
  if (list || q || species || theme)
    return shell(
      `<main class="content"><div class="section-heading"><h1>The village</h1>${link("Explore in 3D", "/")}</div><section class="panel">${search}</section><div class="cards results">${items.length ? items.map(memorialCard).join("") : '<p class="empty">No public memorials match. Try another name or create a place of your own.</p>'}</div></main>`,
    );
  const mine = user
    ? (await api<{ items: Memorial[] }>("/memorials?mine=1")).items
    : [];
  const visible = [
    ...new Map(
      [
        ...items,
        ...mine.filter((v) => v.status !== "archived" && !v.moderated),
      ].map((v) => [v.id, v]),
    ).values(),
  ];
  return shell(
    `<main class="world-page village-live">${worldFrame("village", visible, query.get("focus") || "")}<div class="village-title"><span class="eyebrow">A PLACE TO REMEMBER</span><h1>Everleaf Village</h1><p>Walk a little. Keep their story close.</p><div class="row">${link("Create a memorial", "/create", "btn p")}${link("Memorial list", "/?view=list", "btn")}</div><details class="village-search"><summary>Find a pet</summary>${search}</details></div></main>`,
  );
}
async function homePage() {
  if (authRequired()) return "";
  const { items } = await api<{ items: Memorial[] }>("/memorials?mine=1");
  const cleanup = await api<{ pending: number }>("/cleanup");
  return shell(
    `<main class="content"><div class="section-heading"><h1>My memorials</h1>${link("+ New memorial", "/create", "btn p")}</div>${cleanup.pending ? `<p class="panel">${cleanup.pending} deleted photo files await cleanup. ${button("Retry photo cleanup", "retry-cleanup")}</p>` : ""}${items.length ? `<div class="cards">${items.map((m) => `<div>${memorialCard(m)}${Number((m as unknown as { pending: number }).pending) ? `<p class="panel">${esc((m as unknown as { pending: number }).pending)} memories awaiting review. ${link("Review", `/family/${m.id}`)}</p>` : ""}</div>`).join("")}</div>` : `<section class="panel"><h2>Keep a place of their own.</h2><p>Your memorials and unfinished drafts will appear here.</p>${link("Create a memorial", "/create", "btn p")}</section>`}</main>`,
  );
}
function loginPage(query: URLSearchParams) {
  if (preview)
    return shell(
      `<main class="content narrow"><section class="panel"><h1>Keep a place of their own.</h1><form id="preview-form">${field("Your name", "name", "Keeper", 'required maxlength="80"')}<input type="hidden" name="next" value="${esc(query.get("next") || "/#/home")}">${errorBox()}${finishActions("Continue")}</form></section></main>`,
    );
  return shell(
    `<main class="content narrow"><section class="panel"><h1>Sign in to keep going</h1><p>We’ll send a one-time link. No password needed.</p>${query.get("error") ? '<p class="error">That link expired or was already used. Request a fresh one.</p>' : ""}<form id="login-form">${field("Your name", "name", "", 'required maxlength="80" autocomplete="name"')}${field("Email", "email", "", 'required autocomplete="email"', "email")}<input type="hidden" name="next" value="${esc(query.get("next") || "/#/home")}">${errorBox()}${finishActions("Send sign-in link")}</form><div id="login-result"></div></section></main>`,
  );
}
function createPage() {
  if (!preview && authRequired()) return "";
  return shell(
    `<main class="content narrow"><section class="panel"><h1>Tell us about your pet</h1><p class="muted">Nothing is public until you publish.</p><form id="create-form">${detailsForm()}${errorBox()}${finishActions("Save draft and add photos")}</form></section></main>`,
  );
}
async function editPage(mid: string, step: string) {
  if (authRequired()) return "";
  const m = await loadMemorial(mid);
  if (!canManage(m))
    throw new ApiError(403, "Only the owner can edit this memorial.");
  const title =
    {
      details: "Tell us about your pet",
      photos: "Photographs",
      sculpture: "Choose their sculpture",
      setting: "Where, and in what spirit?",
      personalize: "Make it theirs",
      publish: "A place to share",
    }[step] || "Memorial";
  let inside = "";
  if (step === "details")
    inside = `<form id="details-form">${detailsForm(m)}${errorBox()}${finishActions()}</form>`;
  if (step === "photos")
    inside = `<div class="columns"><section><h2>Public portrait</h2><p class="muted">Choose a portrait visitors will recognize.</p>${portrait(m)}<div class="field"><label for="portrait-file">Add or replace portrait</label><input id="portrait-file" type="file" accept="image/jpeg,image/png,image/webp" data-upload="portrait"></div><div id="crop-tools"></div><h2>Private photographs</h2><p class="small muted">These stay private until you attach an album photo to an approved memory.</p><div class="field"><label for="album-file">Add album photo</label><input id="album-file" type="file" accept="image/jpeg,image/png,image/webp" data-upload="album"></div><div class="media-grid">${(m.media || []).map((f) => mediaTile(f)).join("")}</div>${errorBox()}</section><aside class="panel"><h3>A clear face, kept close.</h3><p>JPG, PNG or WebP · up to 25 MB and 40 megapixels. You can frame the portrait before saving it.</p><div class="form-actions">${link("Continue to sculpture", `/edit/${mid}/sculpture`, "btn p")}</div></aside></div>`;
  if (step === "sculpture")
    inside = `<form id="sculpture-form"><p>Choose a still memorial sculpture from the collection.</p><div class="two" style="margin-top:18px">${[
      [
        "stylized",
        "Stylized sculpture",
        "A sculpted form with your choice of finish.",
      ],
      [
        "photo",
        "Naturalistic sculpture",
        "A more detailed form from the collection.",
      ],
    ]
      .map(
        ([v, n, d]) =>
          `<label class="choice sculpture-card"><img src="/assets/img/species/${m.species}_${v === "photo" ? "photo" : m.finish}.jpg" alt="${esc(n)}"><h2><input type="radio" name="style" value="${v}" ${m.style === v ? "checked" : ""}>${n}</h2><p>${d}</p></label>`,
      )
      .join(
        "",
      )}</div><div class="field"><label for="finish">Finish for the stylized sculpture</label><select id="finish" name="finish">${options(FINISHES, m.finish)}</select></div><p class="collection-note">Both sculptures are from the collection. Your pet’s photographs and memories make the memorial personal.</p>${errorBox()}${finishActions()}</form>`;
  if (step === "setting")
    inside = `<form id="setting-form"><h2>Setting</h2><div class="two">${[
      ["house", "Memory House", "An indoor room of keepsakes."],
      ["garden", "Stillwater", "An outdoor garden place."],
    ]
      .map(
        ([v, n, d]) =>
          `<label class="choice"><input type="radio" name="setting" value="${v}" ${m.setting === v ? "checked" : ""}><b>${n}</b><p>${d}</p></label>`,
      )
      .join(
        "",
      )}</div><h2 style="margin:24px 0 12px">Theme</h2><div class="choices">${Object.entries(
      THEMES,
    )
      .map(
        ([v, t]) =>
          `<label class="choice theme-choice t-${v}"><img src="/assets/img/${v}_${m.setting}.jpg" alt="${esc(t.name)} ${m.setting}"><h3><input type="radio" name="theme" value="${v}" ${m.theme === v ? "checked" : ""}>${t.name}</h3><p class="small">${t.line}</p></label>`,
      )
      .join(
        "",
      )}</div><p class="collection-note">Setting, theme and sculpture are separate choices. Changing them keeps your photos and memories.</p>${errorBox()}${finishActions()}</form>`;
  if (step === "personalize") {
    placement = structuredClone(m.arrangement);
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(
          "everleaf-arrangement:" + user?.id + ":" + mid,
        ) || "null",
      );
      if (
        Array.isArray(saved) &&
        saved.length <= 24 &&
        saved.every(
          (p: Placement) =>
            KEEPSAKES.includes(p.kind) &&
            Number.isFinite(p.x) &&
            Number.isFinite(p.y) &&
            p.x >= 5 &&
            p.x <= 95 &&
            p.y >= 5 &&
            p.y <= 95,
        )
      ) {
        placement = saved;
        dirty = true;
      }
    } catch {}
    inside = `<div class="columns"><section><div class="edit-scene live-arrangement" id="edit-scene">${worldFrame("memorial")}${placement.map((p, i) => placementButton(p, i)).join("")}</div><p class="small muted">Drag a keepsake, or focus it and use the arrow keys. Save when the arrangement feels right.</p></section><aside class="panel"><h2>Keepsakes</h2><div class="place-tools">${KEEPSAKES.map((k) => button("+ " + k, "add-keepsake", "btn", `data-kind="${k}"`)).join("")}</div><div class="place-tools">${button("Reset arrangement", "reset-arrangement")}${button("Save arrangement", "save-arrangement", "btn p")}</div>${errorBox()}<div class="form-actions">${link("Preview & publish", `/edit/${mid}/publish`, "btn p")}</div></aside></div>`;
  }
  if (step === "publish")
    inside = `<div class="columns"><form id="publish-form" class="panel"><h2>Who can visit?</h2><div class="stack">${[
      ["public", "Public", "Appears in the village and search."],
      [
        "link",
        "Link only",
        "Anyone with the link can visit; omitted from search.",
      ],
      ["private", "Private", "Only people you invite can visit."],
    ]
      .map(
        ([v, n, d]) =>
          `<label class="choice"><input type="radio" name="visibility" value="${v}" ${m.visibility === v ? "checked" : ""}><b>${n}</b><p class="small">${d}</p></label>`,
      )
      .join(
        "",
      )}</div><label style="margin-top:20px"><input type="checkbox" name="review" ${m.review ? "checked" : ""}> Review new memories before they appear</label>${m.moderated ? '<p class="error">This memorial is hidden while moderation reviews it. You can still edit its content.</p>' : ""}${!m.portrait_id ? `<p class="error">Add a public portrait before publishing. ${link("Add portrait", `/edit/${mid}/photos`)}</p>` : ""}${errorBox()}${finishActions(m.status === "published" ? "Save visibility and visit" : "Publish memorial")}</form><section class="panel"><h2>Visitor preview</h2>${memorialCard(m)}<p class="small muted" style="margin-top:16px">The selected sculpture is ${esc(m.style === "photo" ? "naturalistic" : FINISHES[m.finish])}. Your portrait and all approved memories stay with the memorial.</p></section></div>`;
  return shell(
    `<main class="content">${stepsUI(m, step)}<div class="section-heading"><div><h1>${title}</h1><p class="muted">${esc(m.name)} · ${m.status === "draft" ? "Private draft" : "Saved memorial"}</p></div>${link("My memorials", "/home")}</div><section class="${["photos", "personalize", "publish"].includes(step) ? "" : "panel"}">${inside}</section></main>`,
    m,
  );
}
function rememberArrangement() {
  world?.setArrangement(placement);
  if (current && user) {
    try {
      sessionStorage.setItem(
        "everleaf-arrangement:" + user.id + ":" + current.id,
        JSON.stringify(placement),
      );
    } catch {}
    dirty = true;
  }
}
function placementButton(p: Placement, i: number) {
  return `<button type="button" class="placement" data-place="${i}" style="left:${p.x}%;top:${p.y}%" aria-label="${esc(p.kind)}, drag or use arrow keys">${esc(p.kind)}</button>`;
}
function mediaTile(f: Media) {
  return `<div class="media-tile"><img src="/media/${f.id}" alt="${esc(f.filename)}"><p class="small">${esc(f.purpose)}</p>${f.purpose === "portrait" ? button("Use portrait", "set-portrait", "btn", `data-id="${f.id}"`) : ""}${button("Remove", "remove-media", "btn", `data-id="${f.id}"`)}</div>`;
}
async function memorialPage(mid: string, readable = false) {
  const m = await loadMemorial(mid);
  const memories = (m.memories || []).filter((v) => v.status === "approved"),
    candles = m.candles || [];
  if (readable)
    return shell(
      `<main class="content"><div class="section-heading"><h1>${esc(m.name)}</h1>${link("Open their place", `/m/${mid}`)}</div><div class="columns"><section class="stack">${memories.length ? memories.map((v) => memoryCard(v, m)).join("") : '<p class="empty">No memories yet. Be the first to add one.</p>'}</section><aside class="panel">${portrait(m)}<p>${esc(m.message)}</p><div class="form-actions">${mayContribute(m) ? link("Light a candle", `/candle/${mid}`, "btn p") : ""}${mayContribute(m) ? link("Add a memory", `/contribute/${mid}`) : ""}</div></aside></div></main>`,
      m,
    );
  return shell(
    `<main class="world-page scene-layout">${worldFrame("memorial")}<details class="memorial-info" ${innerWidth > 700 ? "open" : ""}><summary>${esc(m.name)}<span>${esc([m.born, m.passed].filter(Boolean).join(" – "))}</span></summary><div class="memorial-info-body">${m.portrait ? portrait(m, "world-portrait") : ""}<p>${esc(m.message)}</p><p class="small muted">${m.status === "draft" ? "Unpublished · keeper view" : m.status === "archived" ? "Archived · keeper view" : m.visibility === "public" ? "Public memorial" : m.visibility === "link" ? "Shared by link" : "Invitation only"}</p><div class="row">${canManage(m) ? link("Edit their place", `/edit/${mid}/details`) : ""}${canManage(m) ? link("Family & review", `/family/${mid}`) : ""}${link("Contributors", `/circle/${mid}`)}${link("Read without 3D", `/read/${mid}`)}${link("Report a concern", `/report/${mid}`)}</div></div></details><nav class="memorial-actions">${mayContribute(m) ? link("Light a candle", `/candle/${mid}`, "btn p") : ""}${link("Open memories", `/album/${mid}`)}${mayContribute(m) ? link("Add a memory", `/contribute/${mid}`) : ""}${link("Back to the village", "/")}</nav></main>`,
    m,
  );
}

function memoryCard(v: Memory, m: Memorial, review = false) {
  return `<article class="panel album-entry" id="memory-${v.id}"><h2>${esc(v.title)}</h2><p class="author">${esc(v.author)}${v.date ? " · " + esc(v.date) : ""} · ${esc(v.status)}</p>${v.hidden_media_count ? '<p class="small muted">A photograph is hidden while moderation reviews it.</p>' : ""}${v.media_ids.map((fid) => `<img src="/media/${fid}" alt="Photo shared with this memory">`).join("")}<p>${esc(v.story)}</p><div class="row">${v.user_id === user?.id || canManage(m) ? link("Edit", `/contribute/${m.id}?memory=${v.id}`) : ""}${v.user_id === user?.id || canManage(m) ? button("Remove", "remove-memory", "btn", `data-id="${v.id}"`) : ""}${review && v.status === "pending" ? button("Approve", "approve-memory", "btn p", `data-id="${v.id}"`) + button("Keep private to family", "family-memory", "btn", `data-id="${v.id}"`) + button("Decline", "decline-memory", "btn", `data-id="${v.id}"`) : ""}${["approved", "family"].includes(v.status) ? link("Report", `/report/${m.id}?memory=${v.id}`) : ""}</div></article>`;
}
async function albumPage(mid: string) {
  const m = await loadMemorial(mid);
  return shell(
    `<main class="content"><div class="section-heading"><div><h1>Memories of ${esc(m.name)}</h1><p class="muted">${canManage(m) ? "All memories, including those awaiting review." : "Stories, kept together."}</p></div><div class="row">${mayContribute(m) ? link("Add a memory", `/contribute/${mid}`, "btn p") : ""}${link("Back to their place", `/m/${mid}`)}</div></div><div class="cards">${m.memories?.length ? m.memories.map((v) => memoryCard(v, m)).join("") : '<section class="empty"><h2>No memories yet.</h2><p>Be the first to share a little moment.</p></section>'}</div></main>`,
    m,
  );
}
async function contributePage(mid: string, query: URLSearchParams) {
  if (authRequired()) return "";
  const m = await loadMemorial(mid);
  if (!mayContribute(m))
    throw new ApiError(403, "Your invitation allows visits only.");
  const memory = m.memories?.find((v) => v.id === query.get("memory"));
  return shell(
    `<main class="content narrow"><section class="panel"><h1>${memory ? "Edit your memory" : "Share a memory"} of ${esc(m.name)}</h1><form id="memory-form" data-memory="${memory?.id || ""}">${field("Title", "title", memory?.title || "", 'required maxlength="100"')}${field("When was it? (optional)", "date", memory?.date || "", 'maxlength="60"')}${area("Your memory", "story", memory?.story || "", 'required maxlength="10000"')}<h3>Photographs</h3><div class="media-grid">${(
      m.media || []
    )
      .filter((f) => f.purpose === "album")
      .map(
        (f) =>
          `<label class="media-tile"><input type="checkbox" name="media" value="${f.id}" ${memory?.media_ids.includes(f.id) ? "checked" : ""}><img src="/media/${f.id}" alt="${esc(f.filename)}"></label>`,
      )
      .join(
        "",
      )}</div><div class="field"><label for="memory-photo">Add a photograph</label><input id="memory-photo" type="file" data-upload="album" accept="image/jpeg,image/png,image/webp"></div><p class="small muted">${m.review && !canManage(m) ? "The owner reviews memories before they appear." : "This memory will be visible to people who can visit the memorial."}</p>${!memory || memory.user_id === user?.id ? `<label><input type="checkbox" name="show_name" ${memory?.show_name ? "checked" : ""}> Show my name to visitors</label><p class="small muted">Your name stays private unless you choose to share it. Keepers can see who submitted each memory.</p>` : ""}${errorBox()}${finishActions(memory ? "Save changes" : "Share memory")}</form><div class="form-actions">${link("Back to memories", `/album/${mid}`)}</div></section></main>`,
    m,
  );
}
async function candlePage(mid: string) {
  const m = await loadMemorial(mid);
  const own = m.candles?.find((c) => c.user_id === user?.id);
  return shell(
    `<main class="content narrow"><section class="panel"><h1>A light for ${esc(m.name)}</h1>${!mayContribute(m) ? "<p>New candles and memories are paused here. You can read the tributes below.</p>" : own ? `<div class="candle-glow" aria-hidden="true">🕯</div><h2>Your candle is lit.</h2><p>It stays beside ${esc(m.name)} until ${new Date(own.expires_at).toLocaleDateString()}.</p>${button("Extinguish my candle", "remove-candle", "btn", `data-id="${own.id}"`)}` : `<form id="candle-form">${area("Your words (optional)", "message", "", 'maxlength="500"')}<label><input type="checkbox" name="anonymous"> Don’t show my name</label><p class="small muted">Candles remain for seven days. Each person can keep one active candle here.</p>${errorBox()}${finishActions(user ? "Light candle" : "Sign in to light a candle")}</form>`}<div class="form-actions">${link("Return to their place", `/m/${mid}`)}</div><div class="candle-list">${(m.candles || []).map((c) => `<article><p>${esc(c.message || "A light, with love.")}</p><p class="small muted">${esc(c.author)} · ${new Date(c.created_at).toLocaleDateString()}</p>${canManage(m) ? button("Remove", "remove-candle", "btn", `data-id="${c.id}"`) : ""}</article>`).join("")}</div></section></main>`,
    m,
  );
}
async function familyPage(mid: string) {
  if (authRequired()) return "";
  const m = await loadMemorial(mid);
  const { items } = await api<{ items: Member[] }>(
    "/memorials/" + mid + "/members",
  );
  return shell(
    `<main class="content"><div class="section-heading"><h1>Remembering ${esc(m.name)} together</h1>${link("Return to memorial", `/m/${mid}`)}</div><div class="columns"><section class="stack"><h2>Memories awaiting review</h2>${
      m.memories
        ?.filter((v) => v.status === "pending")
        .map((v) => memoryCard(v, m, true))
        .join("") || '<p class="empty">No memories awaiting review.</p>'
    }</section><aside class="panel"><h2>People & access</h2><form id="invite-form">${field("Invite by email", "email", "", "required", "email")}<div class="field"><label for="role">Access</label><select id="role" name="role"><option value="contributor">Contributor — add memories</option><option value="viewer">Visitor — visit only</option>${m.role === "owner" ? '<option value="keeper">Co-keeper — manage this memorial</option>' : ""}</select></div>${errorBox()}${finishActions("Send invitation")}</form><div id="invite-result"></div>${items.map((v) => `<div class="access-row"><div class="grow"><b>${esc(v.name || v.email)}</b><p class="small muted">${esc(v.email)} · ${v.role} · ${v.status}${v.status === "invited" && v.expires_at ? " · expires " + new Date(v.expires_at).toLocaleDateString() : ""}</p></div>${m.role === "owner" || v.role !== "keeper" ? `<form class="member-role-form" data-id="${v.id}"><label>Access<select name="role">${options(m.role === "owner" ? { viewer: "Visitor", contributor: "Contributor", keeper: "Co-keeper" } : { viewer: "Visitor", contributor: "Contributor" }, v.role)}</select></label><button class="btn">Save access</button></form>${v.status === "invited" ? button("Resend invitation", "resend-invite", "btn", `data-email="${esc(v.email)}" data-role="${v.role}"`) : ""}${button("Revoke", "revoke-member", "btn", `data-id="${v.id}"`)}` : ""}</div>`).join("")}</aside></div></main>`,
    m,
  );
}
async function settingsPage(mid: string) {
  if (authRequired()) return "";
  const m = await loadMemorial(mid);
  if (!canManage(m))
    throw new ApiError(403, "Only the owner can manage this memorial.");
  return shell(
    `<main class="content narrow"><section class="panel"><h1>Care for ${esc(m.name)}’s place.</h1><div class="stack">${link("Memorial details", `/edit/${mid}/details`)}${link("Sculpture, setting & theme", `/edit/${mid}/sculpture`)}${link("Visibility & publishing", `/edit/${mid}/publish`)}${link("People & contribution review", `/family/${mid}`)}<a class="btn" href="/api/memorials/${mid}/export">Export photos and memories (.zip)</a>${button(m.status === "archived" ? "Restore and review" : "Archive memorial", m.status === "archived" ? "restore" : "archive")}${m.role === "owner" ? `<hr><h2>Delete this memorial</h2><p>Deletion removes the memorial, photographs, memories, candles and shared access. Export or archive first if you want to keep them.</p><form id="delete-form">${field(`Type ${esc(m.name)} to confirm`, "confirm", "", 'required autocomplete="off"')}${errorBox()}<div class="form-actions"><button class="btn danger" type="submit">Delete permanently</button></div></form>` : ""}</div></section></main>`,
    m,
  );
}
async function reportPage(mid: string, query: URLSearchParams) {
  if (authRequired()) return "";
  const m = await loadMemorial(mid);
  return shell(
    `<main class="content narrow"><section class="panel"><h1>Report a concern</h1><p>About ${esc(m.name)}’s memorial. Your report goes to the moderation team.</p><form id="report-form"><input type="hidden" name="memory_id" value="${esc(query.get("memory") || "")}"><div class="field"><label for="reason">Reason</label><select id="reason" name="reason"><option value="privacy">Privacy concern</option><option value="inappropriate">Inappropriate contribution</option><option value="other">Something else</option></select></div>${area("What should we know?", "detail", "", 'required maxlength="3000"')}${errorBox()}${finishActions("Send report")}</form></section></main>`,
    m,
  );
}
async function moderationPage() {
  if (authRequired()) return "";
  const { items } = await api<{
    items: (Report & {
      memory_story?: string;
      media: { id: string; filename: string; hidden: boolean }[];
    })[];
  }>("/reports");
  return shell(
    `<main class="content"><h1>Care for the public village</h1><p class="muted">Reports and decisions</p><section class="panel" style="margin-top:22px">${items.length ? items.map((r) => `<article class="report-item"><span class="badge">${esc(r.status)}</span><h2>${esc(r.memorial_name || "Deleted memorial")}</h2><p>${esc(r.reason)} · ${esc(r.detail)}</p>${r.memory_title ? `<h3>${esc(r.memory_title)}</h3><p>${esc(r.memory_story)}</p>` : ""}${r.decision ? `<p class="success">${esc(r.decision)}</p>` : ""}<form class="moderation-form" data-id="${r.id}"><div class="field"><label>Action<select name="action">${r.memory_id ? '<option value="hide_memory">Hide memory</option><option value="restore_memory">Restore memory</option><option value="remove_memory">Remove memory permanently</option>' : ""}${r.media.length ? '<option value="hide_photo">Hide photograph only</option><option value="restore_photo">Restore photograph</option>' : ""}${r.memorial_id ? '<option value="hide_memorial">Hide memorial from visitors</option><option value="restore_memorial">Restore memorial visibility</option>' : ""}<option value="dismiss">Dismiss report</option></select></label></div>${r.media.length ? `<label>Reported photograph<select name="media_id">${r.media.map((f) => `<option value="${f.id}">${esc(f.filename)}${f.hidden ? " (hidden)" : ""}</option>`).join("")}</select></label><div class="media-grid">${r.media.map((f) => `<img class="media-tile" src="/media/${f.id}" alt="${esc(f.filename)}">`).join("")}</div>` : ""}${area("Decision reason", "reason", "", 'required maxlength="2000"')}${errorBox()}${finishActions("Record decision")}</form></article>`).join("") : "<p>No reports to review.</p>"}</section></main>`,
  );
}
async function invitePage(value: string) {
  if (authRequired()) return "";
  const data = await api<{ name: string; role: string; memorial_id: string }>(
    "/invitations/" + value,
  );
  return shell(
    `<main class="content narrow"><section class="panel"><h1>You’re invited to remember ${esc(data.name)}.</h1><p>Access: ${esc(data.role)}. Accept with the email address that received this invitation.</p>${button("Accept invitation", "accept-invite", "btn p", `data-token="${esc(value)}"`)}${errorBox()}</section></main>`,
  );
}
async function circlePage(mid: string) {
  const m = await loadMemorial(mid);
  return shell(
    `<main class="content narrow"><section class="panel"><h1>The people who knew ${esc(m.name)}.</h1>${m.contributors?.length ? m.contributors.map((c) => `<p>${esc(c.name)}</p>`).join("") : "<p>Every shared memory starts with someone who remembers.</p>"}<div class="form-actions">${mayContribute(m) ? link("Add a memory", `/contribute/${mid}`, "btn p") : ""}${link("Return", `/m/${mid}`)}</div></section></main>`,
    m,
  );
}
async function inspectPage(mid: string) {
  const m = await loadMemorial(mid);
  return shell(
    `<main class="world-page sculpture-live">${worldFrame("sculpture")}<section class="sculpture-caption"><h1>${esc(m.name)}’s sculpture</h1><p>Drag to turn. Zoom to look closer.</p><div class="row">${link("Return to their place", `/m/${mid}`)}${canManage(m) ? link("Choose sculpture", `/edit/${mid}/sculpture`, "btn p") : ""}</div></section></main>`,
    m,
  );
}

function draftKey() {
  return `everleaf-draft:${user?.id || "visitor"}:${location.hash}`;
}
function rememberForm(form: HTMLFormElement) {
  if (["login-form", "delete-form", "invite-form"].includes(form.id)) return;
  const values: Record<string, string | boolean | string[]> = {};
  for (const el of form.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("[name]")) {
    if (el.type === "file") continue;
    if (
      el instanceof HTMLInputElement &&
      (el.type === "checkbox" || el.type === "radio")
    ) {
      if (el.type === "radio") {
        if (el.checked) values[el.name] = el.value;
      } else if (el.name === "media") {
        values.media = [
          ...form.querySelectorAll<HTMLInputElement>("[name=media]:checked"),
        ].map((e) => e.value);
      } else values[el.name] = el.checked;
    } else values[el.name] = el.value;
  }
  try {
    sessionStorage.setItem(draftKey(), JSON.stringify(values));
  } catch {}
  dirty = true;
}
function restoreForm() {
  const form = document.querySelector<HTMLFormElement>(
    "#create-form,#details-form,#memory-form,#candle-form,#report-form,#sculpture-form,#setting-form,#publish-form",
  );
  if (!form) return;
  try {
    const raw = sessionStorage.getItem(draftKey());
    if (!raw) return;
    const values = JSON.parse(raw) as Record<string, unknown>;
    for (const e of form.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("[name]")) {
      const value = values[e.name];
      if (e instanceof HTMLInputElement && e.type === "radio") {
        if (typeof value === "string") e.checked = e.value === value;
      } else if (typeof value === "string") e.value = value;
      else if (e instanceof HTMLInputElement && typeof value === "boolean")
        e.checked = value;
      else if (e instanceof HTMLInputElement && Array.isArray(value))
        e.checked = value.includes(e.value);
    }
    dirty = true;
    activeFormPreview(form);
  } catch {}
}
async function render() {
  const head = route().parts;
  // The shared 3D park owns "#/" and "#/p/<id>"; it persists across those routes.
  // "#/park-classic" keeps the old closed park (village_park.glb) as a legacy view.
  if (!head[0] || head[0] === "p" || head[0] === "park-classic") {
    ++revision;
    world?.destroy();
    world = null;
    current = null;
    const legacy = head[0] === "park-classic";
    if (park && parkLegacy !== legacy) { park.destroy(); park = null; }
    parkLegacy = legacy;
    if (!park)
      park = mountParkUI(root, {
        api,
        getUser: () => user,
        setUser: (u) => (user = u),
        isPreview: () => preview,
        go,
        toast,
      }, { legacy });
    document.body.dataset.route = "park";
    document.title = "Everleaf Park";
    park.show(legacy ? null : head[1] || null);
    return;
  }
  park?.destroy();
  park = null;
  const n = ++revision;
  world?.destroy();
  world = null;
  current = null;
  const { parts: p, query: q } = route();
  try {
    let content = "";
    switch (p[0] || "") {
      case "village":
      case "search":
        content = await publicPage(q);
        break;
      case "login":
        content = loginPage(q);
        break;
      case "home":
        content = await homePage();
        break;
      case "create":
        content = createPage();
        break;
      case "edit":
        content = await editPage(p[1], p[2] || "details");
        break;
      case "m":
      case "read":
        content = await memorialPage(p[1], p[0] === "read");
        break;
      case "album":
        content = await albumPage(p[1]);
        break;
      case "contribute":
        content = await contributePage(p[1], q);
        break;
      case "candle":
        content = await candlePage(p[1]);
        break;
      case "family":
        content = await familyPage(p[1]);
        break;
      case "settings":
        content = await settingsPage(p[1]);
        break;
      case "report":
        content = await reportPage(p[1], q);
        break;
      case "moderation":
        content = await moderationPage();
        break;
      case "invite":
        content = await invitePage(p[1]);
        break;
      case "circle":
        content = await circlePage(p[1]);
        break;
      case "inspect":
        content = await inspectPage(p[1]);
        break;
      default:
        throw new ApiError(404, "This page is not available.");
    }
    if (n !== revision || !content) return;
    const active = current as Memorial | null;
    root.className = "t-" + (active?.theme || "N");
    root.innerHTML = content;
    document.title = (active ? active.name + " — " : "") + "Everleaf";
    document.body.dataset.route = p[0] || "village";
    restoreForm();
    window.scrollTo(0, 0);
    const host = root.querySelector<HTMLElement>("#world");
    if (host) {
      world = mountWorld(host, {
        kind: host.dataset.scene as "village" | "memorial" | "sculpture",
        memorial: active || undefined,
        records: JSON.parse(host.dataset.records || "[]"),
        focus: host.dataset.focus,
        onVisit: (id) => go("/m/" + id),
        onCreate: () => go("/create"),
        onAction: (action) =>
          go(action === "village" ? "/" : `/${action}/${active!.id}`),
      });
    }
  } catch (error) {
    if (n !== revision) return;
    root.className = "t-N";
    root.innerHTML = shell(
      `<main class="content narrow"><section class="panel"><h1>${error instanceof ApiError && error.status === 404 ? "This place is not available." : "A little pause."}</h1><p class="error">${esc(error instanceof Error ? error.message : "Please try again.")}</p><div class="form-actions">${link("Back to the village", "/")}${!user ? link("Sign in", "/login?next=" + encodeURIComponent("/#" + location.hash.slice(1)), "btn p") : ""}</div></section></main>`,
    );
  }
}
function showError(error: unknown, form?: Element | null) {
  const target =
    form?.querySelector<HTMLElement>(".error") ||
    document.getElementById("form-error");
  const message =
    error instanceof Error
      ? error.message
      : "That action could not be completed.";
  if (target) {
    target.textContent = message;
    target.scrollIntoView({ block: "nearest" });
  } else toast(message);
}
async function upload(
  file: File,
  purpose: string,
  frame?: { zoom: number; x: number; y: number },
) {
  if (!current) throw Error("Open a memorial first.");
  const r = await fetch(
    `/api/memorials/${current.id}/media?purpose=${purpose}&filename=${encodeURIComponent(file.name)}${frame ? "&" + new URLSearchParams({ zoom: String(frame.zoom), x: String(frame.x), y: String(frame.y) }) : ""}`,
    { method: "POST", headers: { "Content-Type": file.type }, body: file },
  );
  const b = await r.json();
  if (!r.ok) throw new ApiError(r.status, b.error);
  return b as { id: string; url: string };
}
let crop: {
  image: ImageBitmap;
  file: File;
  zoom: number;
  x: number;
  y: number;
} | null = null;
function paintCrop() {
  if (!crop) return;
  const canvas = document.getElementById(
    "crop-canvas",
  ) as HTMLCanvasElement | null;
  if (!canvas) return;
  const c = canvas.getContext("2d")!,
    side = Math.min(crop.image.width, crop.image.height) / crop.zoom,
    x = (crop.image.width - side) * crop.x,
    y = (crop.image.height - side) * crop.y;
  c.drawImage(crop.image, x, y, side, side, 0, 0, 1024, 1024);
}
async function prepareCrop(file: File) {
  const start = location.hash;
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size > 25 * 1024 * 1024
  )
    throw Error("Choose a JPG, PNG or WebP under 25 MB.");
  const image = await createImageBitmap(file);
  if (location.hash !== start) {
    image.close();
    return;
  }
  if (image.width * image.height > 40000000) {
    image.close();
    throw Error("Choose a photograph under 40 megapixels.");
  }
  crop?.image.close();
  crop = { image, file, zoom: 1, x: 0.5, y: 0.5 };
  document.getElementById("crop-tools")!.innerHTML =
    `<div class="panel crop-tools"><h3>Frame their portrait</h3><canvas id="crop-canvas" width="1024" height="1024" aria-label="Portrait crop preview"></canvas><label>Zoom<input type="range" min="1" max="3" value="1" step=".05" data-crop="zoom"></label><label>Horizontal position<input type="range" min="0" max="1" value=".5" step=".01" data-crop="x"></label><label>Vertical position<input type="range" min="0" max="1" value=".5" step=".01" data-crop="y"></label>${button("Save portrait", "save-crop", "btn p")} ${button("Cancel crop", "cancel-crop")}</div>`;
  paintCrop();
}
function activeFormPreview(form: HTMLFormElement) {
  if (form.id === "setting-form") {
    const data = formData(form);
    root.className = "t-" + data.theme;
    form
      .querySelectorAll<HTMLImageElement>(".theme-choice img")
      .forEach((e) => {
        const theme = e
          .closest("label")
          ?.querySelector<HTMLInputElement>("input")?.value;
        e.src = `/assets/img/${theme}_${data.setting}.jpg`;
      });
  }
  if (form.id === "sculpture-form" && current) {
    const data = formData(form);
    form
      .querySelectorAll<HTMLLabelElement>(".sculpture-card")
      .forEach((label) => {
        const image = label.querySelector("img")!;
        const value = label.querySelector<HTMLInputElement>("input")!.value;
        image.src = `/assets/img/species/${current!.species}_${value === "photo" ? "photo" : data.finish}.jpg`;
      });
  }
}
document.addEventListener("input", (event) => {
  const e = event.target as HTMLInputElement;
  if (e.dataset.crop && crop) {
    crop[e.dataset.crop as "zoom" | "x" | "y"] = Number(e.value);
    paintCrop();
    return;
  }
  const form = e.closest("form");
  if (form) rememberForm(form);
});
document.addEventListener("change", async (event) => {
  const e = event.target as HTMLInputElement;
  if (e.form) {
    rememberForm(e.form);
    activeFormPreview(e.form);
  }
  if (!e.dataset.upload || !e.files?.[0]) return;
  const file = e.files[0],
    start = location.hash;
  e.disabled = true;
  try {
    if (e.dataset.upload === "portrait") {
      await prepareCrop(file);
      return;
    }
    await upload(file, e.dataset.upload);
    toast("Photograph saved.");
    if (location.hash === start) await render();
  } catch (error) {
    showError(error);
  } finally {
    e.disabled = false;
  }
});
document.addEventListener("submit", async (event) => {
  const form = event.target as HTMLFormElement;
  if (!form.matches("form")) return;
  event.preventDefault();
  if (form.dataset.busy) return;
  const data = formData(form),
    start = location.hash,
    key = draftKey(),
    m = current,
    controls = [
      ...form.querySelectorAll<
        | HTMLInputElement
        | HTMLButtonElement
        | HTMLSelectElement
        | HTMLTextAreaElement
      >("input,button,select,textarea"),
    ],
    disabled = controls.map((e) => e.disabled);
  const done = (path: string, message?: string) => {
    sessionStorage.removeItem(key);
    dirty = false;
    if (location.hash === start) go(path);
    if (message) toast(message);
  };
  form.dataset.busy = "1";
  controls.forEach((e) => (e.disabled = true));
  try {
    if (form.id === "search-form") {
      go(
        "/?" +
          new URLSearchParams({
            q: data.q,
            species: data.species,
            theme: data.theme,
            view: "list",
          }),
      );
      return;
    }
    if (form.id === "preview-form") {
      const session = await api<{ user: User }>(
        "/preview/session",
        "POST",
        data,
      );
      user = session.user;
      const next = data.next?.startsWith("/#/") ? data.next.slice(2) : "/home";
      done(next);
      await render();
      return;
    }
    if (form.id === "login-form") {
      const result = await api<{ message: string; loginUrl?: string }>(
        "/auth/request",
        "POST",
        data,
      );
      document.getElementById("login-result")!.innerHTML =
        `<p class="success">${esc(result.message)}</p>${result.loginUrl ? `<p class="small muted">Local development sign-in:</p><a class="btn p" href="${esc(result.loginUrl)}">Open sign-in link</a>` : ""}`;
      return;
    }
    if (form.id === "create-form") {
      if (preview && !user) {
        const session = await api<{ user: User }>("/preview/session", "POST", {
          name: "Keeper",
        });
        user = session.user;
      }
      const result = await api<Memorial>("/memorials", "POST", {
        ...defaults,
        ...data,
      });
      done(`/edit/${result.id}/photos`, "Private draft saved.");
      return;
    }
    if (
      !m &&
      form.id !== "moderation-form" &&
      !form.matches(".moderation-form")
    )
      throw Error("Open the memorial again before saving.");
    if (
      [
        "details-form",
        "sculpture-form",
        "setting-form",
        "publish-form",
      ].includes(form.id)
    ) {
      const over: Record<string, unknown> = { ...data };
      if (form.id === "publish-form") {
        over.review = data.review === "on";
        over.status = "published";
      }
      await api<Memorial>(
        "/memorials/" + m!.id,
        "PATCH",
        memorialBody(m!, over),
      );
      const next =
        form.id === "details-form"
          ? "photos"
          : form.id === "sculpture-form"
            ? "setting"
            : form.id === "setting-form"
              ? "personalize"
              : "";
      done(
        next
          ? `/edit/${m!.id}/${next}`
          : form.id === "publish-form" && preview
            ? `/village?focus=${m!.id}`
            : `/m/${m!.id}`,
        form.id === "publish-form" ? "Memorial saved." : "Changes saved.",
      );
      return;
    }
    if (form.id === "memory-form") {
      const fields = {
        ...data,
        show_name: data.show_name === "on",
        media_ids: [
          ...form.querySelectorAll<HTMLInputElement>("[name=media]:checked"),
        ].map((e) => e.value),
      };
      const memoryId = form.dataset.memory;
      const result = await api<{ status: string }>(
        `/memorials/${m!.id}/memories${memoryId ? "/" + memoryId : ""}`,
        memoryId ? "PATCH" : "POST",
        fields,
      );
      done(
        `/album/${m!.id}`,
        result.status === "pending"
          ? "Memory sent for owner review."
          : "Memory saved.",
      );
      return;
    }
    if (form.id === "candle-form") {
      if (!user) {
        go("/login?next=" + encodeURIComponent("/#/candle/" + m!.id));
        return;
      }
      await api(`/memorials/${m!.id}/candles`, "POST", {
        message: data.message,
        anonymous: data.anonymous === "on",
      });
      sessionStorage.removeItem(key);
      dirty = false;
      toast("Your candle is lit.");
      if (location.hash === start) await render();
      return;
    }
    if (form.matches(".member-role-form")) {
      await api(
        `/memorials/${m!.id}/members/${form.dataset.id}`,
        "PATCH",
        data,
      );
      done(`/family/${m!.id}`, "Access updated.");
      if (location.hash === start) await render();
      return;
    }
    if (form.id === "invite-form") {
      const result = await api<{ inviteUrl?: string }>(
        `/memorials/${m!.id}/members`,
        "POST",
        data,
      );
      toast("Invitation created.");
      if (location.hash === start) {
        await render();
        if (result.inviteUrl)
          document.getElementById("invite-result")!.innerHTML =
            `<p class="success">Local invitation link:</p><div class="link-box"><a href="${esc(result.inviteUrl)}">${esc(result.inviteUrl)}</a></div>`;
      }
      return;
    }
    if (form.id === "report-form") {
      const result = await api<{ id: string }>("/reports", "POST", {
        ...data,
        memorial_id: m!.id,
        memory_id: data.memory_id || null,
      });
      done(
        `/m/${m!.id}`,
        "Report received: " +
          result.id.slice(0, 8) +
          ". The moderation team can review it.",
      );
      return;
    }
    if (form.id === "delete-form") {
      if (!confirm(`Permanently delete ${m!.name} and its content?`)) return;
      const result = await api<{ cleanupPending: boolean }>(
        "/memorials/" + m!.id,
        "DELETE",
        data,
      );
      done(
        "/home",
        result.cleanupPending
          ? "Memorial deleted. Photo cleanup is queued for retry."
          : "Memorial and photo files deleted.",
      );
      return;
    }
    if (form.matches(".moderation-form")) {
      if (!confirm("Record this moderation decision?")) return;
      await api("/reports/" + form.dataset.id, "PATCH", data);
      sessionStorage.removeItem(key);
      dirty = false;
      toast("Decision recorded.");
      if (location.hash === start) await render();
      return;
    }
  } catch (error) {
    showError(error, form);
  } finally {
    delete form.dataset.busy;
    controls.forEach((e, i) => (e.disabled = disabled[i]));
  }
});
document.addEventListener("click", async (event) => {
  const target = (event.target as Element).closest<HTMLElement>(
    "[data-action]",
  );
  if (!target) return;
  const action = target.dataset.action!,
    m = current,
    start = location.hash;
  if (target instanceof HTMLButtonElement) target.disabled = true;
  try {
    if (action === "logout") {
      await api("/logout", "POST");
      const prefix = "everleaf-draft:" + user?.id + ":",
        arrangementPrefix = "everleaf-arrangement:" + user?.id + ":";
      for (const k of Object.keys(sessionStorage))
        if (k.startsWith(prefix) || k.startsWith(arrangementPrefix))
          sessionStorage.removeItem(k);
      user = null;
      go("/");
      await render();
      return;
    }
    if (action === "accept-invite") {
      const r = await api<{ memorial_id: string }>(
        "/invitations/" + target.dataset.token,
        "POST",
        {},
      );
      go("/m/" + r.memorial_id);
      return;
    }
    if (action === "retry-cleanup") {
      const result = await api<{ pending: number }>("/cleanup", "POST");
      toast(
        result.pending
          ? "Photo cleanup is still pending. It will retry automatically."
          : "Photo cleanup complete.",
      );
      await render();
      return;
    }
    if (!m) throw Error("Open a memorial first.");
    if (action === "resend-invite") {
      const result = await api<{ inviteUrl?: string }>(
        `/memorials/${m.id}/members`,
        "POST",
        {
          email: target.dataset.email,
          role: target.dataset.role,
        },
      );
      toast("Invitation resent.");
      if (location.hash === start) {
        await render();
        if (result.inviteUrl)
          document.getElementById("invite-result")!.innerHTML =
            `<p class="success">Local invitation link:</p><div class="link-box"><a href="${esc(result.inviteUrl)}">${esc(result.inviteUrl)}</a></div>`;
      }
      return;
    }
    if (action === "cancel-crop") {
      crop?.image.close();
      crop = null;
      document.getElementById("crop-tools")!.innerHTML = "";
      return;
    }
    if (action === "save-crop") {
      if (!crop) throw Error("Choose a portrait first.");
      const selectedCrop = crop;
      await upload(selectedCrop.file, "portrait", {
        zoom: selectedCrop.zoom,
        x: selectedCrop.x,
        y: selectedCrop.y,
      });
      selectedCrop.image.close();
      if (crop === selectedCrop) crop = null;
      toast("Portrait saved.");
      if (location.hash === start) await render();
      return;
    }
    if (action === "add-keepsake") {
      if (placement.length >= 24) throw Error("Use up to 24 keepsakes.");
      placement.push({
        kind: target.dataset.kind as Placement["kind"],
        x: 50,
        y: 65,
      });
      document
        .getElementById("edit-scene")!
        .insertAdjacentHTML(
          "beforeend",
          placementButton(placement.at(-1)!, placement.length - 1),
        );
      rememberArrangement();
      return;
    }
    if (action === "reset-arrangement") {
      if (!confirm("Remove the placed keepsakes? Save to apply this change."))
        return;
      placement = [];
      document
        .querySelectorAll(".placement[data-place]")
        .forEach((e) => e.remove());
      rememberArrangement();
      return;
    }
    if (action === "save-arrangement") {
      await api(
        "/memorials/" + m.id,
        "PATCH",
        memorialBody(m, { arrangement: placement }),
      );
      sessionStorage.removeItem(
        "everleaf-arrangement:" + user?.id + ":" + m.id,
      );
      dirty = false;
      toast("Arrangement saved.");
      if (location.hash === start) await render();
      return;
    }
    if (action === "remove-media") {
      if (!confirm("Remove this photograph?")) return;
      await api(`/memorials/${m.id}/media/${target.dataset.id}`, "DELETE");
    }
    if (action === "set-portrait")
      await api(`/memorials/${m.id}/portrait`, "POST", {
        media_id: target.dataset.id,
        version: m.version,
      });
    if (action === "remove-memory") {
      if (!confirm("Remove this memory?")) return;
      await api(`/memorials/${m.id}/memories/${target.dataset.id}`, "DELETE");
    }
    if (["approve-memory", "decline-memory", "family-memory"].includes(action))
      await api(`/memorials/${m.id}/memories/${target.dataset.id}`, "PATCH", {
        decision:
          action === "approve-memory"
            ? "approved"
            : action === "family-memory"
              ? "family"
              : "declined",
      });
    if (action === "remove-candle")
      await api(`/memorials/${m.id}/candles/${target.dataset.id}`, "DELETE");
    if (action === "revoke-member") {
      if (!confirm("Revoke this person’s access?")) return;
      await api(`/memorials/${m.id}/members/${target.dataset.id}`, "DELETE");
    }
    if (action === "archive" || action === "restore") {
      if (
        action === "archive" &&
        !confirm(
          "Archive this memorial? Visitors will no longer be able to open it. Your content is kept.",
        )
      )
        return;
      await api("/memorials/" + m.id, "PATCH", {
        ...memorialBody(m),
        status: action === "archive" ? "archived" : "draft",
      });
      if (action === "restore") {
        go(`/edit/${m.id}/publish`);
        toast(
          "Restored as a private draft. Review visibility before publishing.",
        );
        return;
      }
    }
    toast("Changes saved.");
    if (location.hash === start) await render();
  } catch (error) {
    showError(error);
  } finally {
    if (target instanceof HTMLButtonElement) target.disabled = false;
  }
});
let drag: {
  el: HTMLElement;
  index: number;
  box: DOMRect;
  pointer: number;
} | null = null;
document.addEventListener("pointerdown", (event) => {
  const el = (event.target as Element).closest<HTMLElement>("[data-place]");
  if (!el) return;
  const scene = document.getElementById("edit-scene")!;
  drag = {
    el,
    index: Number(el.dataset.place),
    box: scene.getBoundingClientRect(),
    pointer: event.pointerId,
  };
  el.setPointerCapture(event.pointerId);
  event.preventDefault();
  el.focus();
});
document.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointer) return;
  const p = placement[drag.index];
  p.x = Math.max(
    5,
    Math.min(95, ((event.clientX - drag.box.left) / drag.box.width) * 100),
  );
  p.y = Math.max(
    5,
    Math.min(95, ((event.clientY - drag.box.top) / drag.box.height) * 100),
  );
  drag.el.style.left = p.x + "%";
  drag.el.style.top = p.y + "%";
  rememberArrangement();
});
document.addEventListener("pointerup", () => (drag = null));
document.addEventListener("keydown", (event) => {
  const el = (event.target as Element).closest<HTMLElement>("[data-place]");
  if (
    !el ||
    !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete"].includes(
      event.key,
    )
  )
    return;
  event.preventDefault();
  const i = Number(el.dataset.place),
    p = placement[i];
  if (event.key === "Delete") {
    placement.splice(i, 1);
    document
      .getElementById("edit-scene")!
      .querySelectorAll("[data-place]")
      .forEach((e) => e.remove());
    document
      .getElementById("edit-scene")!
      .insertAdjacentHTML("beforeend", placement.map(placementButton).join(""));
  } else {
    p.x = Math.max(
      5,
      Math.min(
        95,
        p.x +
          (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0),
      ),
    );
    p.y = Math.max(
      5,
      Math.min(
        95,
        p.y +
          (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0),
      ),
    );
    el.style.left = p.x + "%";
    el.style.top = p.y + "%";
  }
  rememberArrangement();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("hashchange", () => {
  crop?.image.close();
  crop = null;
  dirty = false;
  void render();
});
async function loadMemorial(mid: string) {
  const n = revision,
    m = await api<Memorial>("/memorials/" + mid);
  if (n === revision) current = m;
  return m;
}
async function start() {
  try {
    const session = await api<{ user: User | null; preview: boolean }>(
      "/session",
    );
    user = session.user;
    preview = session.preview;
    await render();
  } catch (error) {
    root.innerHTML = `<main class="content"><p class="error">${esc(error instanceof Error ? error.message : "Everleaf could not open.")}</p></main>`;
  }
}
void start();
