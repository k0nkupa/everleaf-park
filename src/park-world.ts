// Everleaf Park 3D scene: one shared park, a gravestone + pet per memorial plot.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { getAsset, findAnchor, plotEmpties, defaultPlotPosition, type StoneStyle } from "./park-assets.ts";

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

  let empties = new Map<number, THREE.Vector3>();
  const plotPosition = (i: number) => (empties.get(i) || defaultPlotPosition(i)).clone();
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
    if (found.size) { empties = found; void build(); }
    host.dataset.parkAsset = park.userData.placeholder ? "placeholder" : "glb";
  });

  async function buildOne(m: ParkMemorial) {
    const g = new THREE.Group();
    g.position.copy(plotPosition(m.plot));
    const [base, stone, pet] = await Promise.all([getAsset("plot_base"), getAsset(`stone_${m.stone}`), getAsset(`pet_${m.species}`)]);
    stone.position.z = -0.45;
    const anchor = findAnchor(stone);
    const tex = carvedTexture(m.name, yearsLabel(m));
    const w = (anchor?.userData.width as number) || 0.8;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.75), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
    plate.name = "carving";
    if (anchor) { anchor.add(plate); plate.position.z = 0.03; } else { plate.position.set(0, 0.9, 0.2); stone.add(plate); }
    fitHeight(pet, 0.75);
    pet.position.set(-0.45, pet.position.y + 0.1, 0.35);
    pet.rotation.y = 0.5;
    g.add(base, stone, pet);
    const flowers = await getAsset("flowers");
    flowers.position.set(0.55, 0.08, 0.3);
    g.add(flowers);
    for (let i = 0; i < Math.min(m.lights, 5); i++) {
      const c = await getAsset("candle");
      c.position.set(0.25 + i * 0.16, 0.22, -0.05);
      c.name = "candle"; g.add(c);
    }
    for (let i = 0; i < Math.min(m.toys, 3); i++) {
      const t = await getAsset("toy");
      t.position.set(0.1 + i * 0.25, 0.08, 0.75);
      t.name = "toy"; g.add(t);
    }
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.memorialId = m.id; } });
    g.userData.memorialId = m.id;
    return g;
  }
  const plotCount = 48;
  const emptyGeo = new THREE.RingGeometry(1.05, 1.25, 32);
  const emptyMat = new THREE.MeshStandardMaterial({ color: 0x6d8a3e, roughness: 1, transparent: true, opacity: 0.55 });
  let building = 0;
  async function build() {
    const n = ++building;
    const groups = await Promise.all(items.map(buildOne));
    if (n !== building || disposed) return;
    memorialRoot.clear(); pickables.length = 0; byId.clear();
    const used = new Set(items.map((m) => m.plot));
    for (let i = 0; i < plotCount; i++) {
      if (used.has(i)) continue;
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
    return { pos: new THREE.Vector3(0, portrait ? 56 : 27, portrait ? 28 : 22), target: new THREE.Vector3(0, 0, portrait ? 1 : 0.5) };
  }
  function applyCamera(animate = true) {
    let pose = overviewPose();
    const g = focusId ? byId.get(focusId) : undefined;
    if (g) {
      const p = g.position, portrait = host.clientHeight > host.clientWidth;
      pose = { pos: new THREE.Vector3(p.x + 0.5, p.y + (portrait ? 2.9 : 1.9), p.z + (portrait ? 4.2 : 4.4)), target: new THREE.Vector3(p.x + (portrait ? 0 : 0.9), p.y + (portrait ? 0.45 : 0.8), p.z) };
      if (portrait) pose.target.y -= 0; // card sits below; scene stays in top half via CSS height
    } else if (view === "close") {
      pose = { pos: new THREE.Vector3(0, 7, 16), target: new THREE.Vector3(0, 0.8, 4) };
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
    for (const g of pickables) g.visible = !focused || g === focused || g.position.distanceTo(camera.position) > 3.2;
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
