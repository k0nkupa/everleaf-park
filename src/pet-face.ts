// Eyes (and noses) for the first-pass pet sculptures. Those GLBs are one mesh, one material,
// with no eye geometry at all, and each faces a different way. This normalises each to face +Z
// and snaps glossy eyes with a catchlight onto the head surface by raycasting.
import * as THREE from "three";

type Face = {
  /** Yaw that turns the model's face toward +Z. */
  yaw: number;
  /** Eye height as a fraction of model height, lateral offset as a fraction of model width. */
  eyeY: number; eyeX: number;
  /** Eye radius as a fraction of model height. */
  eyeR: number;
  /** Ray start depth: cast from this far into the head (fraction of depth from the front) - lets eyes sit on a snout side. */
  nose?: { y: number; r: number };
  /** Replace near-black coats (the budgie came out 0.01 grey). */
  coat?: number;
  /** The turtle GLB has legs/head/tail but no shell: add a stand-in dome. */
  shell?: number;
  /** Override the snout search band (fractions of height). */
  noseBand?: [number, number];
  /** Place eyes this far (fraction of height) above the snout tip instead of at eyeY. */
  eyesAboveTip?: number;
};
export const PET_FACES: Record<string, Face> = {
  dog: { yaw: Math.PI / 2, eyeY: 0.87, eyeX: 0.09, eyeR: 0.028, nose: { y: 0.8, r: 0.03 } },
  cat: { yaw: Math.PI / 2, eyeY: 0.83, eyeX: 0.1, eyeR: 0.03, nose: { y: 0.78, r: 0.018 } },
  bird: { yaw: -Math.PI / 4, eyeY: 0.86, eyeX: 0.16, eyeR: 0.035, coat: 0x7fbf6a },
  rabbit: { yaw: 0, eyeY: 0.55, eyeX: 0.11, eyeR: 0.03, nose: { y: 0.4, r: 0.022 } },
  guinea: { yaw: -Math.PI * 0.75, eyeY: 0.62, eyeX: 0.13, eyeR: 0.05, nose: { y: 0.45, r: 0.035 } },
  horse: { yaw: 0, eyeY: 0.82, eyeX: 0.07, eyeR: 0.022, nose: { y: 0.64, r: 0.018 } },
  turtle: { yaw: Math.PI, eyeY: 0.7, eyeX: 0.035, eyeR: 0.09, shell: 0x6f8f4a, noseBand: [0.05, 0.95], eyesAboveTip: 0.12 },
};

const eyeMat = new THREE.MeshStandardMaterial({ color: 0x17110d, roughness: 0.18, metalness: 0 });
const shineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const noseMat = new THREE.MeshStandardMaterial({ color: 0x2b1d17, roughness: 0.45, metalness: 0 });
const sphere = new THREE.SphereGeometry(1, 16, 12);
const shared = (m: THREE.Mesh, name: string) => { m.name = name; m.userData.petFeature = true; m.castShadow = false; return m; };

/** Warm, soft pet look: the first-pass pet GLBs default to metallic (dog: dark + glossy under lamps). */
export function softenPet(pet: THREE.Object3D) {
  pet.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshPhysicalMaterial;
    const mat = new THREE.MeshStandardMaterial({ color: src.color?.clone() ?? new THREE.Color(0xb08a64), roughness: 0.82, metalness: 0, map: src.map ?? null });
    const hsl = { h: 0, s: 0, l: 0 };
    mat.color.getHSL(hsl);
    if (hsl.l < 0.42) mat.color.setHSL(hsl.h, Math.min(hsl.s, 0.55), 0.42 + hsl.l * 0.25); // lift very dark coats
    mat.userData.pet = true;
    mesh.material = mat;
    mesh.userData.owned = true; mesh.userData.ownGeometry = false;
    if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
  });
}

/** Wraps the pet in a group facing +Z with eyes (and nose) added. Call after material fixes. */
export function addPetFace(pet: THREE.Object3D, species: string): THREE.Group {
  const face = PET_FACES[species];
  const root = new THREE.Group();
  root.name = "pet-faced";
  root.add(pet);
  if (!face) return root;
  pet.rotation.y += face.yaw;
  pet.traverse((o) => {
    const m = o as THREE.Mesh;
    if (face.coat && m.isMesh) (m.material as THREE.MeshStandardMaterial).color?.set(face.coat);
  });
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(pet), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const meshes: THREE.Object3D[] = [];
  pet.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o); });
  const ray = new THREE.Raycaster();
  const hit = (x: number, y: number) => {
    ray.set(new THREE.Vector3(x, y, box.max.z + 1), new THREE.Vector3(0, 0, -1));
    const h = ray.intersectObjects(meshes, false)[0];
    if (!h) return null;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 0, 1);
    return { p: h.point, n };
  };
  const H = size.y;
  // Snout tip: the frontmost surface point in the nose height band. It fixes the head's x
  // (heads are often off the body's centre line) and anchors the nose.
  const band = face.noseBand ?? [face.nose ? face.nose.y - 0.1 : face.eyeY - 0.15, face.nose ? face.nose.y + 0.1 : face.eyeY + 0.05];
  let tip: { p: THREE.Vector3; n: THREE.Vector3 } | null = null;
  for (let yi = 0; yi <= 8; yi++) for (let xi = 0; xi <= 24; xi++) {
    const h = hit(box.min.x + (xi / 24) * size.x, box.min.y + (band[0] + (band[1] - band[0]) * (yi / 8)) * H);
    if (h && (!tip || h.p.z > tip.p.z)) tip = h;
  }
  const headX = tip ? tip.p.x : c.x;
  const eyeY = face.eyesAboveTip !== undefined && tip ? tip.p.y + face.eyesAboveTip * H : box.min.y + face.eyeY * H;
  for (const side of [-1, 1]) {
    // Retry slightly inward / up and down if a ray slips past the head's edge.
    let h: ReturnType<typeof hit> = null;
    for (const [fx, dy] of [[1, 0], [0.85, 0], [1, 0.02], [1, -0.02], [0.7, 0], [0.85, 0.03], [0.6, -0.03]])
      if ((h = hit(headX + side * face.eyeX * fx * size.x, eyeY + dy * H))) break;
    if (!h) continue;
    const r = face.eyeR * H;
    const eye = shared(new THREE.Mesh(sphere, eyeMat), "pet-eye");
    eye.scale.set(r, r * 1.1, r * 0.75);
    eye.position.copy(h.p).addScaledVector(h.n, r * 0.15);
    eye.lookAt(eye.position.clone().add(h.n));
    const shine = shared(new THREE.Mesh(sphere, shineMat), "pet-eye-shine");
    shine.scale.setScalar(0.32);
    shine.position.set(0.35, 0.4, 0.75); // in eye space: upper side, toward the viewer
    eye.add(shine);
    root.add(eye);
  }
  if (face.nose && tip) {
    const r = face.nose.r * H;
    const nose = shared(new THREE.Mesh(sphere, noseMat), "pet-nose");
    nose.scale.set(r * 1.3, r, r * 0.8);
    nose.position.copy(tip.p).addScaledVector(tip.n, r * 0.2);
    root.add(nose);
  }
  if (face.shell) {
    // Stand-in shell over the body (Garmin to model a real one).
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: face.shell, roughness: 0.75, flatShading: true }));
    dome.name = "pet-shell"; dome.userData.owned = true;
    dome.scale.set(size.x * 0.36, H * 2.2, size.z * 0.3);
    dome.position.set(c.x, box.min.y + H * 0.25, c.z - size.z * 0.08);
    root.add(dome);
  }
  return root;
}
export const PET_SPECIES = Object.keys(PET_FACES);
