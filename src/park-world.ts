// Everleaf Park 3D scene: one shared park, a gravestone + pet per memorial plot.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { getAsset, findAnchor, plotEmpties, defaultPlotPosition, type StoneStyle, type PlotPose } from "./park-assets.ts";
import { softenPet, addPetFace } from "./pet-face.ts";
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
  /** Walk by (dx, dz) metres through the same collision as the keyboard. */
  step(dx: number, dz: number): { x: number; z: number };
  colliders(x: number, z: number): { x: number; z: number; r: number }[];
  /** Pet material check: metalness, roughness and linear luminance of its base colour. */
  /** World position of a memorial's pet (test/screenshot use). */
  petPosition(id: string): [number, number, number] | null;
  petLook(id: string): { metalness: number; roughness: number; luminance: number; eyes: number; species: string } | null;
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
// Stones read better from above at a modest 1.25x; a soft ground ring + far marker do the rest.
const STONE_SCALE = 1.25, PLAYER_R = 0.35, STONE_R = 0.85, CELL = 0.5;
type Collider = { x: number; z: number; r: number };

function radialTexture(inner: string, outer: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!, grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner); grad.addColorStop(0.45, inner.replace(/[\d.]+\)$/, "0.45)")); grad.addColorStop(1, outer);
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let glowTex: THREE.Texture | null = null, ringTex: THREE.Texture | null = null, markerTex: THREE.Texture | null = null;
const candleGlowMat = () => new THREE.SpriteMaterial({ map: (glowTex ??= radialTexture("rgba(255,196,110,1)", "rgba(255,160,60,0)")), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
function ringTexture() {
  if (ringTex) return ringTex;
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d")!, grad = g.createRadialGradient(64, 64, 30, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,226,150,0)"); grad.addColorStop(0.55, "rgba(255,226,150,0.85)"); grad.addColorStop(1, "rgba(255,226,150,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  ringTex = new THREE.CanvasTexture(c); ringTex.colorSpace = THREE.SRGBColorSpace;
  return ringTex;
}
function markerTexture() {
  if (markerTex) return markerTex;
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(255,240,205,0.95)"; g.strokeStyle = "rgba(122,78,40,0.9)"; g.lineWidth = 8;
  g.beginPath(); g.moveTo(64, 10); g.bezierCurveTo(112, 40, 110, 92, 64, 120); g.bezierCurveTo(18, 92, 16, 40, 64, 10); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(64, 26); g.lineTo(64, 108); g.stroke();
  markerTex = new THREE.CanvasTexture(c); markerTex.colorSpace = THREE.SRGBColorSpace;
  return markerTex;
}
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
  const kindPoses = new Map<TileKind, { plots: Map<number, PlotPose>; lamps: THREE.Vector3[]; colliders: Collider[] }>();
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
        // Colliders: anything 0.6-1.7 m tall in the tile (tree trunks, lamp posts, bench backs,
        // planters, the Lantern Tree) marks a 0.5 m cell; each cell is a small circle collider.
        const cells = new Set<string>(), v = new THREE.Vector3();
        t.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const pos = mesh.geometry.attributes.position;
          for (let n = 0; n < pos.count; n++) {
            v.fromBufferAttribute(pos, n).applyMatrix4(mesh.matrixWorld);
            if (v.y > 0.6 && v.y < 1.7 && Math.abs(v.x) < 8 && Math.abs(v.z) < 8) cells.add(`${Math.floor(v.x / CELL)},${Math.floor(v.z / CELL)}`);
          }
        });
        const colliders = [...cells].map((c) => { const [a, b] = c.split(",").map(Number); return { x: (a + 0.5) * CELL, z: (b + 0.5) * CELL, r: CELL * 0.6 }; });
        kindPoses.set(kind, { plots, lamps, colliders });
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
    softenPet(pet);
    const faced = addPetFace(pet, m.species); // faces +Z, with eyes + nose
    fitHeight(faced, 0.45);
    faced.rotation.y = Math.PI + 0.45; // face the visitor (-Z), turned slightly
    const petHolder = new THREE.Group();
    petHolder.add(faced);
    at(stone, "pet_anchor").add(petHolder);
    at(stone, "flower_anchor").add(flowers);
    const candleA = at(stone, "candle_anchor");
    for (let i = 0; i < Math.min(m.lights, 3); i++) {
      const c = await getAsset("candle");
      c.position.x = i * 0.14;
      c.name = "candle";
      const la = at(c, "light_anchor");
      if (i === 0) la.userData.candleLight = true;
      // Cheap per-candle glow: an additive sprite, no real light.
      const glow = new THREE.Sprite(candleGlowMat());
      glow.name = "candle-glow"; glow.scale.setScalar(0.38); glow.userData.owned = true; glow.userData.ownGeometry = false;
      la.add(glow);
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
    g.userData.species = m.species;
    stone.scale.multiplyScalar(STONE_SCALE);
    // Readable from above: a soft warm ring on the plot, plus a leaf marker that fades in at distance.
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), new THREE.MeshBasicMaterial({ map: ringTexture(), transparent: true, depthWrite: false, opacity: 0.75 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.04; ring.name = "plot-ring"; ring.userData.owned = true;
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: markerTexture(), depthWrite: false, transparent: true, opacity: 0 }));
    marker.name = "far-marker"; marker.position.y = 2.6; marker.scale.setScalar(1.4); marker.userData.owned = true; marker.userData.ownGeometry = false;
    g.add(ring, marker);
    return g;
  }
  // Only per-memorial planes own their geometry/material/texture; clones share the cached GLTF data.
  function disposeMemorial(g: THREE.Group) {
    g.removeFromParent();
    g.traverse((o) => {
      if (!o.userData.owned) return;
      const mesh = o as THREE.Mesh, mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat.map && mat.map !== glowTex && mat.map !== ringTex && mat.map !== markerTex && !mat.userData.pet) mat.map.dispose();
      mat.dispose();
      if (o.userData.ownGeometry !== false) mesh.geometry.dispose();
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
  /** Nearby circle colliders: tile geometry cells + stones of rendered memorials. */
  function collidersNear(x: number, z: number, reach = 2.5) {
    const out: Collider[] = [];
    const c = tileAt(x, z);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const t = tiles.get(tileKey(c.i + di, c.j + dj));
      if (!t) continue;
      const o = tileOrigin(t.i, t.j);
      for (const k of kindPoses.get(t.kind)?.colliders ?? []) {
        const wx = k.x + o.x, wz = k.z + o.z;
        if (Math.abs(wx - x) < reach && Math.abs(wz - z) < reach) out.push({ x: wx, z: wz, r: k.r });
      }
    }
    for (const g of pickables) if (Math.abs(g.position.x - x) < reach && Math.abs(g.position.z - z) < reach) out.push({ x: g.position.x, z: g.position.z, r: STONE_R });
    return out;
  }
  /** Move the player by step, pushing out of circles so blocked motion slides along them. */
  function moveWithCollision(step: THREE.Vector3) {
    const p = controls.target;
    const sub = Math.max(1, Math.ceil(step.length() / 0.2));
    for (let n = 0; n < sub; n++) {
      const nx = p.x + step.x / sub, nz = p.z + step.z / sub;
      const near = collidersNear(nx, nz);
      let x = nx, z = nz;
      for (let it = 0; it < 3; it++) for (const c of near) {
        const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz), min = c.r + PLAYER_R;
        if (d < min) {
          // Only resolve if this step pushed us deeper (lets a player who starts inside walk out).
          const before = Math.hypot(p.x - c.x, p.z - c.z);
          if (d >= before) continue;
          const k = d > 1e-4 ? (min - d) / d : 0;
          x += dx * k; z += dz * k;
        }
      }
      p.x = x; p.z = z;
    }
  }
  function walk(dt: number) {
    if (!keys.size) return;
    const f = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
    const s = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
    if (!f && !s) return;
    camera.getWorldDirection(fwd).setY(0).normalize();
    side.crossVectors(fwd, camera.up).normalize();
    step.copy(fwd).multiplyScalar(f).addScaledVector(side, s).normalize()
      .multiplyScalar((keys.has("ShiftLeft") || keys.has("ShiftRight") ? 18 : 8) * dt);
    const before = controls.target.clone();
    moveWithCollision(step);
    camera.position.add(controls.target.clone().sub(before));
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
    const camH = camera.position.y;
    memorialRoot.traverse((o) => {
      if (o.name === "flame") o.scale.y = 1.6 + Math.sin(t * 9 + o.id) * 0.25;
      else if (o.name === "candle-glow") o.scale.setScalar(0.36 + Math.sin(t * 7 + o.id) * 0.04);
      else if (o.name === "far-marker") ((o as THREE.Sprite).material.opacity = THREE.MathUtils.clamp((camH - 18) / 14, 0, 1));
    });
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
    step(dx, dz) {
      const before = controls.target.clone();
      moveWithCollision(new THREE.Vector3(dx, 0, dz));
      camera.position.add(controls.target.clone().sub(before));
      stream();
      return { x: controls.target.x, z: controls.target.z };
    },
    colliders: (x, z) => collidersNear(x, z),
    petPosition(id) {
      let pos: [number, number, number] | null = null;
      byId.get(id)?.traverse((o) => { if (!pos && o.name === "pet-faced") { const b = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()); pos = [b.x, b.y, b.z]; } });
      return pos;
    },
    petLook(id) {
      const g = byId.get(id);
      if (!g) return null;
      let out: { metalness: number; roughness: number; luminance: number; eyes: number; species: string } | null = null;
      let eyes = 0;
      g.traverse((o) => { if (o.name === "pet-eye" && (o as THREE.Mesh).isMesh && o.visible) eyes++; });
      g.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!out && m?.userData?.pet) { const c = m.color; out = { metalness: m.metalness, roughness: m.roughness, luminance: 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, eyes, species: String(g.userData.species) }; }
      });
      return out;
    },
    where(id) {
      const g = byId.get(id);
      return g ? { x: g.position.x, z: g.position.z, plot: g.userData.plotKey } : null;
    },
    shot(pos, target, fogOn = true) {
      controls.maxPolarAngle = Math.PI * 0.495; // allow true eye-level framing
      controls.maxDistance = 400; controls.minDistance = 0.5;
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
  return handle;
}
// keep TILE_SIZE / plotKey exported for callers that only import the world module
export { TILE_SIZE, plotKey };
