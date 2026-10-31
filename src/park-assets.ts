// Asset-loader seam for Everleaf Park.
// Real GLBs from Garmin go in public/models/v2/ with a manifest.json mapping
// AssetKey -> file name. Any key that is missing (or fails to load) falls back
// to the placeholder builder below, so assets can land one at a time.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

export const ASSET_ROOT = "/models/v2/";
export const STONE_KEYS = ["classic", "arch", "heart", "leaf"] as const;
export type StoneStyle = (typeof STONE_KEYS)[number];
export type AssetKey =
  | "park"
  | `tile_${"base" | "alt1" | "alt2" | "landmark"}`
  | `stone_${StoneStyle}`
  | "plot_base"
  | "candle"
  | "flowers"
  | "toy"
  | "toy_ball"
  | "toy_bone"
  | "toy_yarn"
  | `pet_${string}`;

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const cache = new Map<string, Promise<THREE.Object3D | null>>();
let manifest: Promise<Record<string, string>> | null = null;
const getManifest = () =>
  (manifest ??= fetch(ASSET_ROOT + "manifest.json")
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : {}))
    .catch(() => ({}))) as Promise<Record<string, string>>;

// Pets already exist from the first Blender pass; keep using them until v2 pets land.
const legacy: Record<string, string> = {
  pet_dog: "/models/pet_dog.glb",
  pet_cat: "/models/pet_cat.glb",
  pet_bird: "/models/pet_bird.glb",
  pet_rabbit: "/models/pet_rabbit.glb",
  pet_guinea: "/models/pet_guinea.glb",
  pet_horse: "/models/pet_horse.glb",
  pet_turtle: "/models/pet_turtle.glb",
};

async function loadGlb(key: AssetKey): Promise<THREE.Object3D | null> {
  const m = await getManifest();
  const file = m[key] ? ASSET_ROOT + m[key] : legacy[key];
  if (!file) return null;
  try {
    const gltf = await loader.loadAsync(file);
    gltf.scene.userData.source = file;
    return gltf.scene;
  } catch {
    return null;
  }
}

/** Returns a fresh clone of the real asset, or a placeholder if none is available. */
export async function getAsset(key: AssetKey): Promise<THREE.Object3D> {
  if (!cache.has(key)) cache.set(key, loadGlb(key));
  const real = await cache.get(key)!;
  if (real) {
    const c = real.clone(true);
    c.userData.placeholder = false;
    return c;
  }
  const p = placeholder(key);
  p.userData.placeholder = true;
  return p;
}

/** Garmin contract: gravestones carry an empty named "text_anchor" on the front face. */
export function findAnchor(root: THREE.Object3D, name = "text_anchor") {
  let found: THREE.Object3D | undefined;
  root.traverse((o) => {
    if (!found && o.name.toLowerCase().startsWith(name)) found = o;
  });
  return found;
}

/** Garmin contract: the park GLB carries empties named plot_00..plot_NN. */
export type PlotPose = { pos: THREE.Vector3; quat: THREE.Quaternion };
export function plotEmpties(root: THREE.Object3D) {
  const out = new Map<number, PlotPose>();
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    const m = o.name.match(/^plot_(\d+)$/i);
    if (m)
      out.set(Number(m[1]), {
        pos: o.getWorldPosition(new THREE.Vector3()),
        quat: o.getWorldQuaternion(new THREE.Quaternion()),
      });
  });
  return out;
}

// ---------- placeholders ----------
const mat = (color: number, rough = 0.85, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, ...extra });
const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => {
  const x = new THREE.Mesh(g, m);
  x.castShadow = x.receiveShadow = true;
  return x;
};
function extrude(shape: THREE.Shape, depth: number, color: number) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2, curveSegments: 18 });
  g.translate(0, 0, -depth / 2);
  return mesh(g, mat(color, 0.92));
}
function stoneShape(style: StoneStyle) {
  const s = new THREE.Shape();
  if (style === "classic") {
    s.moveTo(-0.45, 0); s.lineTo(0.45, 0); s.lineTo(0.45, 0.9);
    s.absarc(0, 0.9, 0.45, 0, Math.PI, false); s.lineTo(-0.45, 0);
  } else if (style === "arch") {
    s.moveTo(-0.55, 0); s.lineTo(0.55, 0); s.lineTo(0.55, 0.75);
    s.quadraticCurveTo(0.55, 1.45, 0, 1.55); s.quadraticCurveTo(-0.55, 1.45, -0.55, 0.75); s.lineTo(-0.55, 0);
  } else if (style === "heart") {
    s.moveTo(0, 0); s.bezierCurveTo(-0.2, 0.25, -0.75, 0.55, -0.7, 1.0);
    s.bezierCurveTo(-0.66, 1.35, -0.15, 1.45, 0, 1.12);
    s.bezierCurveTo(0.15, 1.45, 0.66, 1.35, 0.7, 1.0);
    s.bezierCurveTo(0.75, 0.55, 0.2, 0.25, 0, 0);
  } else {
    s.moveTo(0, 0); s.bezierCurveTo(0.75, 0.35, 0.7, 1.15, 0, 1.6);
    s.bezierCurveTo(-0.7, 1.15, -0.75, 0.35, 0, 0);
  }
  return s;
}
const STONE_COLOR: Record<StoneStyle, number> = { classic: 0xb8b1a5, arch: 0xd8d0c2, heart: 0xc9a59a, leaf: 0x9fae8c };
export const STONE_FACE_Z = 0.2;
function placeholderStone(style: StoneStyle) {
  // Mirrors Garmin's contract: pivot at plot centre, face points -Z, bed in front, named anchors.
  const outer = new THREE.Group();
  const inner = placeholderStoneBody(style);
  inner.rotation.y = Math.PI;
  inner.position.z = 0.45;
  const bed = placeholder("plot_base");
  bed.scale.setScalar(0.6);
  bed.position.z = -0.2;
  outer.add(bed, inner);
  const add = (name: string, x: number, y: number, z: number) => {
    const a = new THREE.Object3D();
    a.name = name;
    a.position.set(x, y, z);
    outer.add(a);
  };
  const faceZ = 0.45 - STONE_FACE_Z - 0.01;
  add("text_anchor", 0, 1.05, faceZ);
  add("years_anchor", 0, 0.82, faceZ);
  add("photo_anchor", 0, 1.32, faceZ);
  add("pet_anchor", -0.3, 0.1, -0.35);
  add("flower_anchor", 0.35, 0.1, -0.25);
  add("candle_anchor", 0.15, 0.22, 0.05);
  add("toy_anchor", 0.05, 0.08, -0.6);
  return outer;
}
function placeholderStoneBody(style: StoneStyle) {
  const g = new THREE.Group();
  const plinth = mesh(new THREE.BoxGeometry(1.4, 0.22, 0.6), mat(0x9d968b));
  plinth.position.y = 0.11;
  const body = extrude(stoneShape(style), 0.24, STONE_COLOR[style]);
  body.position.y = style === "heart" ? 0.18 : 0.22;
  g.add(plinth, body);
  return g;
}
function placeholderPet(species: string) {
  const colors: Record<string, number> = { dog: 0xc98b4f, cat: 0x8a8590, bird: 0x6bb36a, rabbit: 0xd8c8b4, guinea: 0xa86a42, horse: 0x7a5236, turtle: 0x6d8a4c };
  const m = mat(colors[species] ?? 0xb08a64, 0.7);
  const g = new THREE.Group();
  const body = mesh(new THREE.SphereGeometry(0.28, 16, 12), m);
  body.scale.set(1, 0.85, 1.35); body.position.y = 0.3;
  const head = mesh(new THREE.SphereGeometry(0.2, 16, 12), m);
  head.position.set(0, 0.58, 0.3);
  for (const x of [-0.1, 0.1]) {
    const ear = mesh(new THREE.ConeGeometry(0.06, species === "rabbit" ? 0.32 : 0.14, 8), m);
    ear.position.set(x, species === "rabbit" ? 0.88 : 0.76, 0.28);
    g.add(ear);
  }
  g.add(body, head);
  return g;
}
function placeholder(key: AssetKey): THREE.Object3D {
  if (key.startsWith("stone_")) return placeholderStone(key.slice(6) as StoneStyle);
  if (key.startsWith("pet_")) return placeholderPet(key.slice(4));
  if (key === "plot_base") {
    const g = new THREE.Group();
    const soil = mesh(new THREE.CylinderGeometry(1.25, 1.35, 0.1, 28), mat(0x7a4630, 1));
    soil.scale.z = 0.8; soil.position.y = 0.05;
    const rim = mesh(new THREE.TorusGeometry(1.3, 0.06, 6, 32), mat(0x9a7a5a, 1));
    rim.rotation.x = Math.PI / 2; rim.scale.y = 0.8; rim.position.y = 0.08;
    g.add(soil, rim);
    return g;
  }
  if (key === "candle") {
    const g = new THREE.Group();
    const wax = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 10), mat(0xfff3dc));
    wax.position.y = 0.09;
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffc45a }));
    flame.scale.y = 1.7; flame.position.y = 0.22; flame.name = "flame";
    const la = new THREE.Object3D();
    la.name = "light_anchor"; la.position.y = 0.22;
    g.add(wax, flame, la);
    return g;
  }
  if (key === "flowers") {
    const g = new THREE.Group();
    const cols = [0xe86a7a, 0xf2c14e, 0xb48be0, 0xffffff];
    for (let i = 0; i < 5; i++) {
      const stem = mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.22), mat(0x4f7a3a));
      const bloom = mesh(new THREE.SphereGeometry(0.055, 8, 6), mat(cols[i % 4], 0.6));
      const x = (i - 2) * 0.07, z = (i % 2) * 0.06;
      stem.position.set(x, 0.11, z); bloom.position.set(x, 0.23, z);
      g.add(stem, bloom);
    }
    return g;
  }
  if (key.startsWith("toy")) {
    const ball = mesh(new THREE.SphereGeometry(0.1, 14, 10), mat(0xe2553f, 0.5));
    ball.position.y = 0.1;
    const g = new THREE.Group();
    g.add(ball);
    return g;
  }
  if (key.startsWith("tile_")) return placeholderTile(key === "tile_landmark");
  return buildPlaceholderPark();
}
// 16x16 m stand-in tile: lawn + the cross path that joins on all four sides.
function placeholderTile(landmark: boolean) {
  const g = new THREE.Group();
  const lawn = mesh(new THREE.PlaneGeometry(16, 16), mat(landmark ? 0x86a052 : 0x7f9a4a, 1));
  lawn.rotation.x = -Math.PI / 2;
  g.add(lawn);
  for (const r of [0, Math.PI / 2]) {
    const p = mesh(new THREE.PlaneGeometry(2.4, 16), mat(0xd9a86a, 1));
    p.rotation.set(-Math.PI / 2, 0, r); p.position.y = 0.01;
    g.add(p);
  }
  return g;
}

// Simple park: lawn, cross paths, plaza ring, central leaf monument, lamps, benches, trees.
export const PLOTS_PER_QUADRANT = 12;
export function defaultPlotPosition(i: number) {
  const q = Math.floor(i / PLOTS_PER_QUADRANT), local = i % PLOTS_PER_QUADRANT;
  const row = Math.floor(local / 4), col = local % 4;
  const sx = q % 2 ? 1 : -1, sz = q < 2 ? -1 : 1;
  return new THREE.Vector3(sx * (6.2 + col * 3.4), 0, sz * (6.4 + row * 3.8));
}
function buildPlaceholderPark() {
  const g = new THREE.Group();
  const lawn = mesh(new THREE.PlaneGeometry(90, 90), mat(0x7f9a4a, 1));
  lawn.rotation.x = -Math.PI / 2;
  g.add(lawn);
  const pathMat = mat(0xd9a86a, 1);
  for (const r of [0, Math.PI / 2]) {
    const p = mesh(new THREE.PlaneGeometry(3, 80), pathMat);
    p.rotation.set(-Math.PI / 2, 0, r); p.position.y = 0.01;
    g.add(p);
  }
  const plaza = mesh(new THREE.CircleGeometry(5.2, 40), mat(0xe0b47c, 1));
  plaza.rotation.x = -Math.PI / 2; plaza.position.y = 0.015;
  g.add(plaza);
  // Monument: round bed with a stylised leaf (Everleaf's own centrepiece).
  const bed = mesh(new THREE.CylinderGeometry(1.8, 2, 0.4, 32), mat(0x8c7a64));
  bed.position.y = 0.2;
  const soil = mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.05, 32), mat(0x5e7f3c));
  soil.position.y = 0.42;
  const leaf = extrude(stoneShape("leaf"), 0.3, 0x6f9e58);
  leaf.scale.setScalar(1.6); leaf.position.y = 0.45;
  const vein = mesh(new THREE.BoxGeometry(0.05, 2.2, 0.36), mat(0xcfe0a8));
  vein.position.y = 1.55;
  g.add(bed, soil, leaf, vein);
  const lampMat = mat(0x3b3229, 0.6), glow = new THREE.MeshBasicMaterial({ color: 0xffe2a0 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const post = mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.4, 8), lampMat);
    post.position.set(Math.cos(a) * 5.6, 1.2, Math.sin(a) * 5.6);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), glow);
    bulb.position.set(post.position.x, 2.5, post.position.z);
    g.add(post, bulb);
  }
  const wood = mat(0x8a5a35);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const bench = new THREE.Group();
    const seat = mesh(new THREE.BoxGeometry(1.5, 0.08, 0.45), wood);
    seat.position.y = 0.45;
    const back = mesh(new THREE.BoxGeometry(1.5, 0.4, 0.06), wood);
    back.position.set(0, 0.7, -0.2);
    for (const x of [-0.65, 0.65]) {
      const leg = mesh(new THREE.BoxGeometry(0.08, 0.45, 0.4), wood);
      leg.position.set(x, 0.22, 0);
      bench.add(leg);
    }
    bench.add(seat, back);
    bench.position.set(Math.cos(a) * 4.2, 0, Math.sin(a) * 4.2);
    bench.lookAt(0, 0, 0);
    g.add(bench);
  }
  const trunk = mat(0x6b4a30), crown = mat(0x4f7a35, 0.95), crown2 = mat(0x6a8f3e, 0.95);
  const rnd = (n: number) => (Math.sin(n * 91.7) * 43758.5) % 1;
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2, r = 25 + Math.abs(rnd(i)) * 8;
    const t = new THREE.Group();
    const tk = mesh(new THREE.CylinderGeometry(0.25, 0.35, 2, 8), trunk);
    tk.position.y = 1;
    t.add(tk);
    for (let k = 0; k < 3; k++) {
      const c = mesh(new THREE.IcosahedronGeometry(1.4 - k * 0.2, 1), k % 2 ? crown2 : crown);
      c.position.set((k - 1) * 0.7, 2.6 + k * 0.5, (k % 2) * 0.5);
      t.add(c);
    }
    t.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    t.scale.setScalar(1 + Math.abs(rnd(i + 5)) * 0.6);
    g.add(t);
  }
  // Grass tufts / wildflowers for texture.
  const tuft = new THREE.InstancedMesh(new THREE.ConeGeometry(0.06, 0.25, 4), mat(0x9bb85a), 900);
  const bloom = new THREE.InstancedMesh(new THREE.SphereGeometry(0.06, 6, 4), mat(0xf4efe0, 0.7), 300);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 900; i++) {
    const x = rnd(i * 3) * 40, z = rnd(i * 7) * 40;
    if (Math.abs(x) < 1.8 || Math.abs(z) < 1.8 || Math.hypot(x, z) < 5.4) {
      tuft.setMatrixAt(i, m4.makeScale(0, 0, 0));
      if (i < 300) bloom.setMatrixAt(i, m4);
      continue;
    }
    tuft.setMatrixAt(i, m4.makeTranslation(x, 0.12, z));
    if (i < 300) bloom.setMatrixAt(i, m4.makeTranslation(x + 0.3, 0.1, z - 0.2));
  }
  g.add(tuft, bloom);
  return g;
}
