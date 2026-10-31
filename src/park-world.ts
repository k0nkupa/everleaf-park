// Everleaf Park 3D scene: one shared park, a gravestone + pet per memorial plot.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { getAsset, findAnchor, plotEmpties, defaultPlotPosition, type StoneStyle, type PlotPose } from "./park-assets.ts";

export type ParkMemorial = {
  id: string; name: string; species: string; born: string; passed: string; message: string;
  plot: number; stone: StoneStyle; portrait: string | null; visits: number; lights: number; toys: number;
};
export type ParkView = "overview" | "close";
export type ParkHandle = {
  setMemorials(items: ParkMemorial[]): Promise<void>;
  focus(id: string | null): void;
  setView(v: ParkView): void;
  view(): ParkView;
  plotPosition(i: number): THREE.Vector3;
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

export function mountPark(
  host: HTMLElement,
  opts: { onSelect(id: string): void; onReady?(): void },
): ParkHandle {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfe3d6);
  scene.fog = new THREE.Fog(0xcfe3d6, 85, 160);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.className = "park-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Everleaf Park in 3D. Use the Pets list for a readable directory.");
  host.prepend(canvas);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 220);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.42;
  controls.minDistance = 3; controls.maxDistance = 70;
  controls.screenSpacePanning = false;
  scene.add(new THREE.HemisphereLight(0xfff4dc, 0x5d6b3a, 1.4));
  const sun = new THREE.DirectionalLight(0xffe0b0, 2.4);
  sun.position.set(-18, 30, 14); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, far: 90 });
  sun.shadow.normalBias = 0.03;
  scene.add(sun);

  let empties = new Map<number, PlotPose>();
  const plotPose = (i: number): PlotPose => {
    const e = empties.get(i);
    return e ? { pos: e.pos.clone(), quat: e.quat.clone() } : { pos: defaultPlotPosition(i), quat: new THREE.Quaternion() };
  };
  const plotPosition = (i: number) => plotPose(i).pos;
  const memorialRoot = new THREE.Group();
  scene.add(memorialRoot);
  const pickables: THREE.Object3D[] = [];
  const byId = new Map<string, THREE.Group>();
  let items: ParkMemorial[] = [];
  let view: ParkView = "overview", focusId: string | null = null, disposed = false;
  const goal = { pos: new THREE.Vector3(), target: new THREE.Vector3(), active: false };

  void getAsset("park").then((park) => {
    if (disposed) return;
    park.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.receiveShadow = true; });
    scene.add(park);
    const found = plotEmpties(park);
    host.dataset.parkAsset = park.userData.placeholder ? "placeholder" : "glb";
    if (found.size) { empties = found; void build(); }
  });

  const texLoader = new THREE.TextureLoader();
  const FACE_W: Record<string, number> = { classic: 0.52, arch: 0.49, heart: 0.6, leaf: 0.5 };
  const TOYS = ["toy_ball", "toy_bone", "toy_yarn"] as const;
  // A flat plane at an anchor, turned to face the stone's forward (-Z).
  const facePlane = (w: number, h: number, map: THREE.Texture, at: THREE.Object3D) => {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map, transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
    plane.rotation.y = Math.PI;
    plane.position.z = -0.002;
    at.add(plane);
    return plane;
  };
  const at = (root: THREE.Object3D, name: string) => findAnchor(root, name) || root;
  async function buildOne(m: ParkMemorial) {
    const g = new THREE.Group();
    const pose = plotPose(m.plot);
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
    const petA = at(stone, "pet_anchor");
    const petHolder = new THREE.Group();
    petHolder.add(pet);
    petA.add(petHolder);
    at(stone, "flower_anchor").add(flowers);
    const candleA = at(stone, "candle_anchor");
    for (let i = 0; i < Math.min(m.lights, 3); i++) {
      const c = await getAsset("candle");
      c.position.x = i * 0.14;
      c.name = "candle";
      if (i === 0 && lightBudget.n-- > 0) {
        const glow = new THREE.PointLight(0xffb45a, 1.4, 2.2, 2);
        at(c, "light_anchor").add(glow);
      }
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
    return g;
  }
  const plotCount = 36;
  const lightBudget = { n: 8 };
  const emptyGeo = new THREE.RingGeometry(1.05, 1.25, 32);
  const emptyMat = new THREE.MeshStandardMaterial({ color: 0x6d8a3e, roughness: 1, transparent: true, opacity: 0.55 });
  let building = 0;
  async function build() {
    const n = ++building;
    lightBudget.n = 8;
    const groups = await Promise.all(items.map(buildOne));
    if (n !== building || disposed) return;
    memorialRoot.clear(); pickables.length = 0; byId.clear();
    const used = new Set(items.map((m) => m.plot));
    for (let i = 0; i < plotCount; i++) {
      if (used.has(i) || host.dataset.parkAsset === "glb") continue;
      const ring = new THREE.Mesh(emptyGeo, emptyMat);
      ring.rotation.x = -Math.PI / 2; ring.scale.y = 0.8;
      ring.position.copy(plotPosition(i)).setY(0.03);
      memorialRoot.add(ring);
    }
    groups.forEach((g, i) => { memorialRoot.add(g); pickables.push(g); byId.set(items[i].id, g); });
    host.dataset.memorials = String(groups.length);
    host.dataset.ready = "1";
    opts.onReady?.();
    if (focusId) applyCamera(false);
  }

  function overviewPose() {
    const portrait = host.clientHeight > host.clientWidth;
    return { pos: new THREE.Vector3(0, portrait ? 40 : 21, portrait ? 21 : 18), target: new THREE.Vector3(0, 0, portrait ? 0.5 : 0.5) };
  }
  function applyCamera(animate = true) {
    let pose = overviewPose();
    const g = focusId ? byId.get(focusId) : undefined;
    if (g) {
      const portrait = host.clientHeight > host.clientWidth;
      const local = new THREE.Vector3(0.35, portrait ? 2.1 : 1.45, portrait ? -3.4 : -3.0).applyQuaternion(g.quaternion);
      const target = g.position.clone().add(new THREE.Vector3(0, portrait ? 0.45 : 0.7, 0));
      const pos = g.position.clone().add(local);
      if (!portrait) {
        // Shift the stone left of centre so the info card doesn't cover it.
        const dir = target.clone().sub(pos).normalize();
        target.add(new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(0.75));
      }
      pose = { pos, target };
    } else if (view === "close") {
      pose = { pos: new THREE.Vector3(0, 5, 14), target: new THREE.Vector3(0, 0.8, 3) };
    }
    goal.pos.copy(pose.pos); goal.target.copy(pose.target); goal.active = true;
    if (!animate) { camera.position.copy(goal.pos); controls.target.copy(goal.target); }
    host.dataset.view = focusId ? "memorial" : view;
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
  const ro = new ResizeObserver(() => { resize(); if (!focusId) applyCamera(); });
  ro.observe(host);
  resize(); applyCamera(false);
  const clock = new THREE.Clock();
  let frame = 0;
  const tick = () => {
    if (disposed) return;
    frame = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
    if (goal.active) {
      const k = 1 - Math.pow(0.002, dt);
      camera.position.lerp(goal.pos, k); controls.target.lerp(goal.target, k);
      if (camera.position.distanceTo(goal.pos) < 0.02) goal.active = false;
    }
    // Keep neighbouring stones from blocking the close-up.
    const focused = focusId ? byId.get(focusId) : undefined;
    for (const g of pickables) g.visible = !focused || g === focused || g.position.distanceTo(camera.position) > 2.4;
    memorialRoot.traverse((o) => { if (o.name === "flame") o.scale.y = 1.6 + Math.sin(t * 9 + o.id) * 0.25; });
    controls.update();
    renderer.render(scene, camera);
    host.dataset.camera = camera.position.toArray().map((v) => v.toFixed(1)).join(",");
  };
  tick();

  return {
    async setMemorials(next) { items = next; await build(); },
    focus(id) { focusId = id; applyCamera(); },
    setView(v) { view = v; focusId = null; applyCamera(); },
    view: () => view,
    plotPosition,
    destroy() {
      disposed = true; cancelAnimationFrame(frame); ro.disconnect(); controls.dispose();
      renderer.dispose(); canvas.remove();
    },
  };
}
