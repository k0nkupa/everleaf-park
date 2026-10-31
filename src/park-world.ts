// Everleaf Park 3D scene: one shared park, a gravestone + pet per memorial plot.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { getAsset, findAnchor, plotEmpties, defaultPlotPosition, type StoneStyle, type PlotPose } from "./park-assets.ts";
import { TILE_KINDS, TILE_SIZE, tileKind, tileAt, tileOrigin, plotKey, type GlobalPlot, type TileKind } from "./park-grid.ts";

export type ParkMemorial = {
  id: string; name: string; species: string; born: string; passed: string; message: string;
  plot: GlobalPlot; plot_key: string; legacy_plot: number | null; stone: StoneStyle; portrait: string | null; visits: number; lights: number; toys: number;
};
export type ParkView = "overview" | "close";
export type ParkHandle = {
  setMemorials(items: ParkMemorial[]): Promise<void>;
  focus(id: string | null): void;
  setView(v: ParkView): void;
  view(): ParkView;
  /** Tile under the camera target (the "player"). */
  center(): { i: number; j: number };
  /** Move the player to a ground point (x, z); instant skips the glide. */
  walkTo(x: number, z: number, instant?: boolean): void;
  /** Loaded tile keys "i,j" and rendered memorial ids, for checks and the HUD. */
  stats(): { tiles: string[]; memorials: string[]; parsed: number; lights: number };
  /** World [x, z] and plot key of a rendered memorial, or null when its tile isn't loaded. */
  where(id: string): { x: number; z: number; plot: string } | null;
  /** Debug/screenshot camera: absolute position + target, fog on/off. */
  shot(pos: [number, number, number], target: [number, number, number], fog?: boolean): void;
  destroy(): void;
};

function carvedTexture(name: string, years: string) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 384;
  const g = c.getContext("2d")!;
  g.textAlign = "center"; g.textBaseline = "middle";
  const carve = (text: string, y: number, size: number) => {
    let s = size;
    g.font = `600 ${s}px Georgia, "Times New Roman", serif`;
    while (g.measureText(text).width > 460 && s > 30) g.font = `600 ${(s -= 4)}px Georgia, serif`;
    g.fillStyle = "rgba(255,255,255,0.55)"; g.fillText(text, 256, y + 3); // lower lip highlight
    g.fillStyle = "rgba(40,30,22,0.82)"; g.fillText(text, 256, y);       // cut
  };
  carve(name, 150, 112);
  carve(years, 270, 58);
  g.strokeStyle = "rgba(40,30,22,0.45)"; g.lineWidth = 4;
  g.beginPath(); g.moveTo(170, 212); g.lineTo(342, 212); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function carvedLine(text: string, aspect: number) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = Math.round(512 * aspect);
  const g = c.getContext("2d")!;
  g.textAlign = "center"; g.textBaseline = "middle";
  let size = c.height * 0.8;
  g.font = `600 ${size}px Georgia, serif`;
  while (g.measureText(text).width > 480 && size > 12) g.font = `600 ${(size -= 3)}px Georgia, serif`;
  g.fillStyle = "rgba(255,255,255,0.5)"; g.fillText(text, 256, c.height / 2 + 2);
  g.fillStyle = "rgba(38,28,20,0.88)"; g.fillText(text, 256, c.height / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
export const yearsLabel = (m: Pick<ParkMemorial, "born" | "passed">) =>
  [m.born, m.passed].filter(Boolean).join(" – ");

function fitHeight(o: THREE.Object3D, h: number) {
  const box = new THREE.Box3().setFromObject(o), size = box.getSize(new THREE.Vector3());
  if (size.y > 0) o.scale.multiplyScalar(h / size.y);
  const b2 = new THREE.Box3().setFromObject(o);
  o.position.y -= b2.min.y;
}

export type ParkOpts = {
  onSelect(id: string): void;
  onReady?(): void;
  /** Player moved to another tile (for the coords HUD). */
  onMove?(info: { i: number; j: number; x: number; z: number; tiles: number }): void;
  /** Closed village_park.glb with plot_index placement (#/park-classic). */
  legacy?: boolean;
};

// Streaming radius (in tiles, Chebyshev): load <= LOAD_R, drop > DROP_R. The gap is hysteresis
// so walking back and forth over a seam doesn't thrash.
const LOAD_R = 2, DROP_R = 3, LAMP_LIGHTS = 6;
const tileKey = (i: number, j: number) => `${i},${j}`;

type Tile = { i: number; j: number; kind: TileKind; root: THREE.Object3D; memorials: THREE.Group[] };

export function mountPark(host: HTMLElement, opts: ParkOpts): ParkHandle {
  const legacy = Boolean(opts.legacy);
  const scene = new THREE.Scene();
  const sky = legacy ? 0xcfe3d6 : 0xc9d8cc;
  scene.background = new THREE.Color(sky);
  const fog = legacy ? new THREE.Fog(sky, 85, 160) : new THREE.Fog(sky, 42, 78);
  scene.fog = fog;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.className = "park-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Everleaf Park in 3D. Walk with WASD or the arrow keys. Use the Pets list for a readable directory.");
  host.prepend(canvas);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, legacy ? 220 : 160);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.42;
  controls.minDistance = 3; controls.maxDistance = legacy ? 70 : 60;
  controls.screenSpacePanning = false;
  scene.add(new THREE.HemisphereLight(0xfff4dc, 0x5d6b3a, 1.4));
  const sun = new THREE.DirectionalLight(0xffe0b0, 2.4);
  const SUN_OFFSET = new THREE.Vector3(-18, 30, 14);
  sun.position.copy(SUN_OFFSET); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, far: 90 });
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // A fixed pool of lamp lights: the light count never changes, so materials never recompile
  // while walking. Each pool light jumps to one of the nearest lamp / candle anchors.
  const lampPool: THREE.PointLight[] = [];
  if (!legacy) for (let n = 0; n < LAMP_LIGHTS; n++) {
    const l = new THREE.PointLight(0xffc27a, 0, 9, 1.6);
    lampPool.push(l); scene.add(l);
  }

  // ---------- plot poses ----------
  let empties = new Map<number, PlotPose>(); // legacy park
  const kindPoses = new Map<TileKind, { plots: Map<number, PlotPose>; lamps: THREE.Vector3[] }>();
  const fallbackTilePose = (k: number): PlotPose => {
    const col = k % 4, row = Math.floor(k / 4);
    return { pos: new THREE.Vector3([-6.1, -3.3, 3.3, 6.1][col], 0, [-6.2, -3.2, 3.2, 6.2][row % 4]), quat: new THREE.Quaternion() };
  };
  /** World pose of a memorial's plot (tiles are never rotated, so local + tile offset). */
  const plotPose = (m: ParkMemorial): PlotPose | null => {
    if (legacy) {
      if (m.legacy_plot === null) return null;
      const e = empties.get(m.legacy_plot);
      return e ? { pos: e.pos.clone(), quat: e.quat.clone() } : { pos: defaultPlotPosition(m.legacy_plot), quat: new THREE.Quaternion() };
    }
    const local = kindPoses.get(tileKind(m.plot.i, m.plot.j))?.plots.get(m.plot.k) ?? fallbackTilePose(m.plot.k);
    const o = tileOrigin(m.plot.i, m.plot.j);
    return { pos: local.pos.clone().add(new THREE.Vector3(o.x, 0, o.z)), quat: local.quat.clone() };
  };

  const memorialRoot = new THREE.Group();
  const tileRoot = new THREE.Group();
  scene.add(tileRoot, memorialRoot);
  const pickables: THREE.Object3D[] = [];
  const byId = new Map<string, THREE.Group>();
  let items: ParkMemorial[] = [];
  let view: ParkView = "overview", focusId: string | null = null, disposed = false;
  const goal = { pos: new THREE.Vector3(), target: new THREE.Vector3(), active: false };
  const tiles = new Map<string, Tile>();
  const loading = new Set<string>();
  let center = { i: 0, j: 0 };
  let generation = 0; // bumps when memorials change so stale async builds are dropped

  // Every tile type is fetched + parsed once (getAsset caches the GLTF) and then cloned per tile.
  const templatesReady = legacy
    ? Promise.resolve()
    : Promise.all(TILE_KINDS.map(async (kind) => {
        const t = await getAsset(`tile_${kind}`);
        const plots = plotEmpties(t);
        const lamps: THREE.Vector3[] = [];
        t.updateWorldMatrix(true, true);
        t.traverse((o) => { if (/^lamp_\d+$/.test(o.name)) lamps.push(o.getWorldPosition(new THREE.Vector3())); });
        kindPoses.set(kind, { plots, lamps });
        host.dataset.parkAsset = t.userData.placeholder ? "placeholder" : "glb";
      })).then(() => undefined);

  if (legacy)
    void getAsset("park").then((park) => {
      if (disposed) return;
      park.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.receiveShadow = true; });
      tileRoot.add(park);
      const found = plotEmpties(park);
      host.dataset.parkAsset = park.userData.placeholder ? "placeholder" : "glb";
      if (found.size) empties = found;
      void build();
    });

  const texLoader = new THREE.TextureLoader();
  const FACE_W: Record<string, number> = { classic: 0.52, arch: 0.49, heart: 0.6, leaf: 0.5 };
  const TOYS = ["toy_ball", "toy_bone", "toy_yarn"] as const;
  // A flat plane at an anchor, turned to face the stone's forward (-Z).
  const facePlane = (w: number, h: number, map: THREE.Texture, at: THREE.Object3D) => {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map, transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
    plane.rotation.y = Math.PI;
    plane.position.z = -0.002;
    plane.userData.owned = true;
    at.add(plane);
    return plane;
  };
  const at = (root: THREE.Object3D, name: string) => findAnchor(root, name) || root;
  async function buildOne(m: ParkMemorial, pose: PlotPose) {
    const g = new THREE.Group();
    g.position.copy(pose.pos);
    g.quaternion.copy(pose.quat);
    const [stone, pet, flowers] = await Promise.all([getAsset(`stone_${m.stone}`), getAsset(`pet_${m.species}`), getAsset("flowers")]);
    g.add(stone);
    const w = FACE_W[m.stone] || 0.5;
    // Engraved name and years: canvas decals on Garmin's text/years anchors.
    const textA = findAnchor(stone, "text_anchor"), yearsA = findAnchor(stone, "years_anchor");
    if (textA && yearsA) {
      facePlane(w * 0.95, w * 0.24, carvedLine(m.name, 0.24), textA).name = "carving";
      facePlane(w * 0.8, w * 0.12, carvedLine(yearsLabel(m), 0.15), yearsA).name = "carving-years";
    } else facePlane(w, w * 0.75, carvedTexture(m.name, yearsLabel(m)), textA || stone).name = "carving";
    const photoA = findAnchor(stone, "photo_anchor");
    if (photoA && m.portrait) {
      const tex = texLoader.load(m.portrait);
      tex.colorSpace = THREE.SRGBColorSpace;
      facePlane(w * 0.34, w * 0.34, tex, photoA).name = "photo";
    }
    fitHeight(pet, 0.45);
    pet.rotation.y = Math.PI + 0.45; // face the visitor (-Z), turned slightly
    const petHolder = new THREE.Group();
    petHolder.add(pet);
    at(stone, "pet_anchor").add(petHolder);
    at(stone, "flower_anchor").add(flowers);
    const candleA = at(stone, "candle_anchor");
    for (let i = 0; i < Math.min(m.lights, 3); i++) {
      const c = await getAsset("candle");
      c.position.x = i * 0.14;
      c.name = "candle";
      if (i === 0) { const la = at(c, "light_anchor"); la.userData.candleLight = true; }
      candleA.add(c);
    }
    const toyA = at(stone, "toy_anchor");
    for (let i = 0; i < Math.min(m.toys, 3); i++) {
      const t = await getAsset(TOYS[i % 3]);
      t.position.x = i * 0.22 - 0.22;
      t.name = "toy";
      toyA.add(t);
    }
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.memorialId = m.id; } });
    g.userData.memorialId = m.id;
    g.userData.plotKey = m.plot_key;
    return g;
  }
  // Only per-memorial planes own their geometry/material/texture; clones share the cached GLTF data.
  function disposeMemorial(g: THREE.Group) {
    g.removeFromParent();
    g.traverse((o) => {
      if (!o.userData.owned) return;
      const mesh = o as THREE.Mesh, mat = mesh.material as THREE.MeshStandardMaterial;
      mat.map?.dispose(); mat.dispose(); mesh.geometry.dispose();
    });
    const p = pickables.indexOf(g);
    if (p >= 0) pickables.splice(p, 1);
    if (byId.get(g.userData.memorialId) === g) byId.delete(g.userData.memorialId);
  }
  const itemsOnTile = (i: number, j: number) => items.filter((m) => m.plot.i === i && m.plot.j === j);
  async function populate(tile: Tile) {
    const gen = generation;
    const groups = await Promise.all(itemsOnTile(tile.i, tile.j).map((m) => buildOne(m, plotPose(m)!)));
    if (disposed || gen !== generation || tiles.get(tileKey(tile.i, tile.j)) !== tile) { groups.forEach(disposeMemorial); return; }
    tile.memorials.forEach(disposeMemorial);
    tile.memorials = groups;
    for (const g of groups) { memorialRoot.add(g); pickables.push(g); byId.set(g.userData.memorialId, g); }
    publish();
  }

  // ---------- legacy (closed park) build ----------
  let legacyGroups: THREE.Group[] = [];
  async function build() {
    if (!legacy) {
      generation++;
      await templatesReady;
      await Promise.all([...tiles.values()].map(populate));
      publish();
      return;
    }
    const gen = ++generation;
    const placed = items.filter((m) => m.legacy_plot !== null);
    const groups = await Promise.all(placed.map((m) => buildOne(m, plotPose(m)!)));
    if (gen !== generation || disposed) { groups.forEach(disposeMemorial); return; }
    legacyGroups.forEach(disposeMemorial);
    legacyGroups = groups;
    for (const g of groups) { memorialRoot.add(g); pickables.push(g); byId.set(g.userData.memorialId, g); }
    publish();
  }

  // ---------- streaming ----------
  const wanted = (i: number, j: number) => Math.max(Math.abs(i - center.i), Math.abs(j - center.j));
  async function loadTile(i: number, j: number) {
    const key = tileKey(i, j);
    loading.add(key);
    await templatesReady;
    const kind = tileKind(i, j);
    const root = await getAsset(`tile_${kind}`);
    loading.delete(key);
    if (disposed || wanted(i, j) > DROP_R || tiles.has(key)) return;
    const o = tileOrigin(i, j);
    root.position.set(o.x, 0, o.z); // never rotated: plot facing assumes an unrotated tile
    root.traverse((x) => { if ((x as THREE.Mesh).isMesh) x.receiveShadow = true; });
    root.name = `tile_${key}`;
    root.userData.tile = { i, j, kind };
    const tile: Tile = { i, j, kind, root, memorials: [] };
    tiles.set(key, tile);
    tileRoot.add(root);
    publish();
    await populate(tile);
  }
  function unloadTile(key: string) {
    const t = tiles.get(key);
    if (!t) return;
    t.root.removeFromParent(); // shared geometry/materials stay cached for the next clone
    t.memorials.forEach(disposeMemorial);
    tiles.delete(key);
  }
  let pendingLoads: { i: number; j: number; d: number }[] = [];
  function stream(force = false) {
    if (legacy) return;
    const c = tileAt(controls.target.x, controls.target.z);
    if (!force && c.i === center.i && c.j === center.j) return;
    center = c;
    for (const key of [...tiles.keys()]) {
      const [i, j] = key.split(",").map(Number);
      if (wanted(i, j) > DROP_R) unloadTile(key);
    }
    pendingLoads = [];
    for (let di = -LOAD_R; di <= LOAD_R; di++) for (let dj = -LOAD_R; dj <= LOAD_R; dj++) {
      const i = c.i + di, j = c.j + dj, key = tileKey(i, j);
      if (!tiles.has(key) && !loading.has(key)) pendingLoads.push({ i, j, d: Math.hypot(di, dj) });
    }
    pendingLoads.sort((a, b) => a.d - b.d);
    publish();
  }
  // At most one new tile per frame keeps the clone + upload cost spread out (no walking hitches).
  function pumpLoads() {
    const next = pendingLoads.shift();
    if (next && wanted(next.i, next.j) <= LOAD_R) void loadTile(next.i, next.j);
  }

  let lampTimer = 0;
  const lampPoints: THREE.Vector3[] = [];
  function placeLamps() {
    if (legacy || !lampPool.length) return;
    lampPoints.length = 0;
    for (const t of tiles.values()) {
      const o = tileOrigin(t.i, t.j);
      for (const p of kindPoses.get(t.kind)?.lamps ?? []) lampPoints.push(new THREE.Vector3(p.x + o.x, p.y, p.z + o.z));
    }
    memorialRoot.traverse((o) => { if (o.userData.candleLight) lampPoints.push(o.getWorldPosition(new THREE.Vector3())); });
    const ref = controls.target;
    lampPoints.sort((a, b) => a.distanceToSquared(ref) - b.distanceToSquared(ref));
    lampPool.forEach((l, n) => {
      const p = lampPoints[n];
      if (p) { l.position.copy(p); l.intensity = p.y < 1 ? 1.4 : 5; l.distance = p.y < 1 ? 2.4 : 9; }
      else l.intensity = 0;
    });
  }

  let readyOnce = false;
  function publish() {
    host.dataset.tiles = [...tiles.keys()].sort().join(";");
    host.dataset.tileCount = String(tiles.size);
    host.dataset.center = `${center.i},${center.j}`;
    host.dataset.memorials = String(byId.size);
    host.dataset.memorialIds = [...byId.keys()].sort().join(",");
    const full = legacy || (pendingLoads.length === 0 && loading.size === 0 && tiles.size >= (2 * LOAD_R + 1) ** 2);
    if (full && !readyOnce) { readyOnce = true; host.dataset.ready = "1"; opts.onReady?.(); if (focusId) applyCamera(false); }
    host.dataset.streaming = full ? "idle" : "loading";
    opts.onMove?.({ i: center.i, j: center.j, x: controls.target.x, z: controls.target.z, tiles: tiles.size });
  }

  // ---------- camera ----------
  const home = new THREE.Vector3(0, 0, legacy ? 0.5 : -3); // player stands on the landmark plaza's south side
  function overviewPose(around: THREE.Vector3) {
    const portrait = host.clientHeight > host.clientWidth;
    const t = new THREE.Vector3(around.x, 0, around.z);
    return { pos: t.clone().add(new THREE.Vector3(0, portrait ? 40 : 21, portrait ? 21 : 18)), target: t };
  }
  function memorialPose(m: ParkMemorial) {
    const p = plotPose(m);
    if (!p) return null;
    const portrait = host.clientHeight > host.clientWidth;
    const local = new THREE.Vector3(0.35, portrait ? 2.1 : 1.45, portrait ? -3.4 : -3.0).applyQuaternion(p.quat);
    const target = p.pos.clone().add(new THREE.Vector3(0, portrait ? 0.45 : 0.7, 0));
    const pos = p.pos.clone().add(local);
    if (!portrait) {
      // Shift the stone left of centre so the info card doesn't cover it.
      const dir = target.clone().sub(pos).normalize();
      target.add(new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(0.75));
    }
    return { pos, target };
  }
  let lastAround = home.clone();
  function applyCamera(animate = true) {
    // Mid-glide (walkTo / plaza), re-pose around where the player is heading, not where they are.
    const tgt = goal.active ? goal.target : controls.target;
    const around = focusId ? lastAround : new THREE.Vector3(tgt.x, 0, tgt.z);
    let pose = overviewPose(legacy ? home : around);
    const m = focusId ? items.find((x) => x.id === focusId) : undefined;
    const mp = m && memorialPose(m);
    if (mp) pose = mp;
    else if (view === "close") {
      const t = legacy ? new THREE.Vector3(0, 0.8, 3) : around.clone().setY(0.8);
      pose = { pos: t.clone().add(new THREE.Vector3(0, 4.2, legacy ? 11 : 9)), target: t };
    }
    goal.pos.copy(pose.pos); goal.target.copy(pose.target); goal.active = true;
    if (!animate) { camera.position.copy(goal.pos); controls.target.copy(goal.target); stream(); }
    host.dataset.view = focusId ? "memorial" : view;
  }

  // ---------- walking (WASD / arrows; shift = run) ----------
  const keys = new Set<string>();
  const typing = (e: KeyboardEvent) => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName || "") || (e.target as HTMLElement)?.isContentEditable;
  const WALK = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);
  const onDown = (e: KeyboardEvent) => { if (!legacy && !typing(e) && WALK.has(e.code) && !focusId) { keys.add(e.code); if (e.code.startsWith("Arrow")) e.preventDefault(); } };
  const onUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();
  addEventListener("keydown", onDown); addEventListener("keyup", onUp); addEventListener("blur", onBlur);
  const fwd = new THREE.Vector3(), side = new THREE.Vector3(), step = new THREE.Vector3();
  function walk(dt: number) {
    if (!keys.size) return;
    const f = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
    const s = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
    if (!f && !s) return;
    camera.getWorldDirection(fwd).setY(0).normalize();
    side.crossVectors(fwd, camera.up).normalize();
    step.copy(fwd).multiplyScalar(f).addScaledVector(side, s).normalize()
      .multiplyScalar((keys.has("ShiftLeft") || keys.has("ShiftRight") ? 18 : 8) * dt);
    camera.position.add(step); controls.target.add(step);
    goal.active = false;
  }

  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; goal.active = false; });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    const r = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pickables, true)[0];
    const id = hit?.object.userData.memorialId as string | undefined;
    if (id) opts.onSelect(id);
  });
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    canvas.style.cursor = raycaster.intersectObjects(pickables, true).length ? "pointer" : "grab";
  });

  const resize = () => {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(() => { resize(); if (!focusId && goal.active) applyCamera(); });
  ro.observe(host);
  resize();
  controls.target.copy(home);
  applyCamera(false);
  stream(true);
  const clock = new THREE.Clock();
  let frame = 0;
  const tick = () => {
    if (disposed) return;
    frame = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
    walk(dt);
    if (goal.active) {
      const k = 1 - Math.pow(0.002, dt);
      camera.position.lerp(goal.pos, k); controls.target.lerp(goal.target, k);
      if (camera.position.distanceTo(goal.pos) < 0.02) goal.active = false;
    }
    stream();
    pumpLoads();
    // Sun + shadow box follow the player so shadows exist on every tile.
    sun.target.position.set(controls.target.x, 0, controls.target.z);
    sun.position.copy(sun.target.position).add(SUN_OFFSET);
    if ((lampTimer -= dt) <= 0) { lampTimer = 0.25; placeLamps(); }
    // Keep neighbouring stones from blocking the close-up.
    const focused = focusId ? byId.get(focusId) : undefined;
    for (const g of pickables) g.visible = !focused || g === focused || g.position.distanceTo(camera.position) > 2.4;
    memorialRoot.traverse((o) => { if (o.name === "flame") o.scale.y = 1.6 + Math.sin(t * 9 + o.id) * 0.25; });
    controls.update();
    renderer.render(scene, camera);
    host.dataset.camera = camera.position.toArray().map((v) => v.toFixed(1)).join(",");
  };
  tick();

  const handle: ParkHandle = {
    async setMemorials(next) { items = next; await build(); },
    focus(id) {
      if (id && !focusId) lastAround = new THREE.Vector3(controls.target.x, 0, controls.target.z);
      focusId = id;
      if (!id) { applyCamera(); return; }
      // The memorial may sit on a far tile: gliding the target there streams its tile in.
      void templatesReady.then(() => { if (focusId === id) applyCamera(); });
    },
    setView(v) { view = v; focusId = null; applyCamera(); },
    view: () => view,
    center: () => ({ ...center }),
    walkTo(x, z, instant = false) {
      focusId = null;
      const delta = new THREE.Vector3(x, 0, z).sub(new THREE.Vector3(controls.target.x, 0, controls.target.z));
      goal.pos.copy(camera.position).add(delta); goal.target.copy(controls.target).add(delta); goal.active = true;
      if (instant) { camera.position.copy(goal.pos); controls.target.copy(goal.target); goal.active = false; stream(); }
    },
    stats: () => ({ tiles: [...tiles.keys()], memorials: [...byId.keys()], parsed: kindPoses.size, lights: lampPool.filter((l) => l.intensity > 0).length }),
    where(id) {
      const g = byId.get(id);
      return g ? { x: g.position.x, z: g.position.z, plot: g.userData.plotKey } : null;
    },
    shot(pos, target, fogOn = true) {
      goal.active = false; focusId = null;
      camera.position.set(...pos); controls.target.set(...target);
      scene.fog = fogOn ? fog : null;
      camera.far = fogOn ? (legacy ? 220 : 160) : 400; camera.updateProjectionMatrix();
      stream();
    },
    destroy() {
      disposed = true; cancelAnimationFrame(frame); ro.disconnect(); controls.dispose();
      removeEventListener("keydown", onDown); removeEventListener("keyup", onUp); removeEventListener("blur", onBlur);
      for (const k of [...tiles.keys()]) unloadTile(k);
      renderer.dispose(); canvas.remove();
    },
  };
  (host as HTMLElement & { park?: ParkHandle }).park = handle;
  return handle;
}
// keep TILE_SIZE / plotKey exported for callers that only import the world module
export { TILE_SIZE, plotKey };
