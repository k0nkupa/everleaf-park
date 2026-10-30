import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Memorial, Placement } from "./types.ts";
export type WorldOptions = {
  kind: "village" | "memorial" | "sculpture";
  memorial?: Memorial;
  records?: Memorial[];
  focus?: string;
  onVisit: (id: string) => void;
  onCreate: () => void;
  onAction: (action: "album" | "candle" | "inspect" | "village") => void;
};
type SceneData = {
  camera: { position: number[]; target: number[]; width: number };
  colliders: number[][];
  plots: number[][];
  photos: { node: string; position: number[] }[];
  sculpture?: { position: number[]; bounds: number[] };
};
let sharedSurface:
  { canvas: HTMLCanvasElement; renderer: THREE.WebGLRenderer } | undefined;
export type WorldHandle = {
  destroy: () => void;
  setArrangement: (placements: Placement[]) => void;
};
const palette = {
  A: { sky: 0xe8c6a2, sun: 0xffd4a0, ground: 0x8b795e },
  B: { sky: 0xb5d8e3, sun: 0xfff0ce, ground: 0x9bada0 },
  C: { sky: 0x17263f, sun: 0xffd3a4, ground: 0x5e5278 },
};
function disposeTree(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>();
  root.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
      if (o instanceof THREE.Mesh) geometries.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        materials.add(m);
        for (const v of Object.values(m))
          if (v instanceof THREE.Texture) textures.add(v);
      }
    }
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  for (const t of textures) {
    t.dispose();
    if (t.image instanceof ImageBitmap) t.image.close();
  }
}
export function mountWorld(
  host: HTMLElement,
  options: WorldOptions,
): WorldHandle {
  const abort = new AbortController(),
    signal = abort.signal;
  let disposed = false,
    frame = 0,
    ready = false,
    sceneData: SceneData,
    selected: Memorial | undefined,
    model: THREE.Group | undefined;
  const scene = new THREE.Scene(),
    player = new THREE.Group(),
    keepsakes = new THREE.Group(),
    interactive: THREE.Object3D[] = [],
    keys = new Set<string>();
  const raycaster = new THREE.Raycaster(),
    pointer = new THREE.Vector2(),
    ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.06),
    destination = new THREE.Vector3(),
    hasDestination = { value: false };
  const m = options.memorial,
    theme = palette[m?.theme || "A"];
  scene.background = new THREE.Color(theme.sky);
  scene.fog = new THREE.Fog(theme.sky, 45, 105);
  const canvas = sharedSurface?.canvas || document.createElement("canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute(
    "aria-label",
    options.kind === "village"
      ? "Explore the 3D village"
      : "Explore the 3D memorial",
  );
  canvas.textContent = "Use the readable view if 3D is unavailable.";
  canvas.className = "world-canvas";
  host.prepend(canvas);
  const status = host.querySelector<HTMLElement>(".world-status")!;
  const labels: { element: HTMLButtonElement; position: THREE.Vector3 }[] = [];
  let renderer: THREE.WebGLRenderer;
  try {
    renderer =
      sharedSurface?.renderer ||
      new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    sharedSurface = { canvas, renderer };
  } catch {
    status.textContent =
      "3D is unavailable in this browser. Use the list or readable view.";
    host.dataset.ready = "error";
    return {
      destroy: () => {
        abort.abort();
        canvas.remove();
      },
      setArrangement: () => {},
    };
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = m?.theme === "C" ? 1.5 : 1.2;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const camera =
    options.kind === "village"
      ? new THREE.OrthographicCamera(-12, 12, 9, -9, 0.05, 180)
      : new THREE.PerspectiveCamera(55, 1, 0.05, 180);
  camera.rotation.reorder("YXZ");
  const entryPosition = new THREE.Vector3(),
    entryCamera = new THREE.Vector3(),
    entryTarget = new THREE.Vector3(),
    entryRotation = new THREE.Quaternion();
  const controls = new OrbitControls(camera, canvas);
  controls.enabled = options.kind !== "memorial";
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.minZoom = 0.6;
  controls.maxZoom = 4;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = 1.4;
  scene.add(
    new THREE.HemisphereLight(
      m?.theme === "C" ? 0x9bb9dd : 0xfff1df,
      theme.ground,
      m?.theme === "C" ? 1.8 : 2.6,
    ),
  );
  const sun = new THREE.DirectionalLight(theme.sun, m?.theme === "C" ? 2 : 3);
  sun.position.set(-10, 22, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -22;
  sun.shadow.camera.right = 22;
  sun.shadow.camera.top = 22;
  sun.shadow.camera.bottom = -22;
  sun.shadow.camera.far = 70;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xb9d4ed, 0.6);
  fill.position.set(10, 8, -10);
  scene.add(fill);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  async function load(path: string) {
    const response = await fetch(path, { signal });
    if (!response.ok) throw Error("The 3D asset could not be loaded.");
    const gltf = await loader.parseAsync(
      await response.arrayBuffer(),
      "/models/",
    );
    if (disposed) {
      disposeTree(gltf.scene);
      throw new DOMException("Aborted", "AbortError");
    }
    return gltf.scene;
  }
  function mesh(
    geometry: THREE.BufferGeometry,
    color: number,
    position: [number, number, number],
    parent: THREE.Object3D = scene,
  ) {
    const object = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color, roughness: 0.65 }),
    );
    object.position.set(...position);
    object.castShadow = true;
    object.receiveShadow = true;
    parent.add(object);
    return object;
  }
  function cylinder(
    radius: number,
    height: number,
    color: number,
    position: [number, number, number],
    parent: THREE.Object3D = scene,
  ) {
    return mesh(
      new THREE.CylinderGeometry(radius, radius, height, 24),
      color,
      position,
      parent,
    );
  }
  function label(text: string) {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 112;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff9eb";
    ctx.beginPath();
    ctx.roundRect(4, 4, 504, 100, 28);
    ctx.fill();
    ctx.strokeStyle = "#9f8357";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#302d37";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 32px Georgia";
    let t = text;
    while (ctx.measureText(t).width > 460) t = t.slice(0, -2) + "…";
    ctx.fillText(t, 256, 54);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, depthTest: false }),
    );
    sprite.scale.set(2.5, 0.55, 1);
    sprite.renderOrder = 10;
    return sprite;
  }
  function clickable(object: THREE.Object3D, action: () => void) {
    object.userData.activate = action;
    interactive.push(object);
  }
  function fitSculpture(
    pet: THREE.Group,
    target: THREE.Box3,
    memorial: Memorial,
  ) {
    const original = new THREE.Box3().setFromObject(pet),
      size = original.getSize(new THREE.Vector3()),
      targetSize = target.getSize(new THREE.Vector3());
    const scale = Math.min(
      Math.max(targetSize.y, 0.6) / Math.max(size.y, 0.001),
      1.2 / Math.max(size.x, size.z, 0.001),
    );
    pet.scale.setScalar(scale);
    const box = new THREE.Box3().setFromObject(pet),
      center = box.getCenter(new THREE.Vector3()),
      goal = target.getCenter(new THREE.Vector3());
    pet.position.add(
      new THREE.Vector3(
        goal.x - center.x,
        target.min.y - box.min.y,
        goal.z - center.z,
      ),
    );
    pet.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const finish =
          memorial.style === "stylized"
            ? { bronze: 0x906034, glaze: 0xeee6d7, marble: 0xd2d0cc }[
                memorial.finish
              ]
            : {
                dog: 0xbf955c,
                cat: 0xc5ac8b,
                rabbit: 0xddd2c4,
                bird: 0x6f9472,
                horse: 0x7e4431,
                guinea: 0x9a7253,
                turtle: 0x59785e,
              }[memorial.species];
        const old = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of old) mat.dispose();
        o.material = new THREE.MeshStandardMaterial({
          color: finish,
          metalness:
            memorial.style === "stylized" && memorial.finish === "bronze"
              ? 0.65
              : 0.02,
          roughness: memorial.style === "photo" ? 0.75 : 0.36,
        });
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return pet;
  }
  async function petModel(memorial: Memorial) {
    return load(
      "/models/" +
        (memorial.species === "dog"
          ? "pet_dog_" + (memorial.style === "photo" ? "photo" : "stylized")
          : "pet_" + memorial.species) +
        ".glb",
    );
  }
  function plotPosition(index: number) {
    if (sceneData.plots?.[index])
      return new THREE.Vector3(
        ...(sceneData.plots[index] as [number, number, number]),
      );
    const angle = (index - 20) * 2.39996,
      r = 16 + Math.floor((index - 20) / 18) * 3;
    return new THREE.Vector3(Math.cos(angle) * r, 0.55, Math.sin(angle) * r);
  }
  const selection = host.querySelector<HTMLElement>(".world-selection")!,
    selectionName = selection.querySelector<HTMLElement>(
      "[data-selection-name]",
    )!,
    selectionEnter = selection.querySelector<HTMLButtonElement>(
      "[data-world-control=enter]",
    )!;
  function select(record: Memorial) {
    selected = record;
    selection.hidden = false;
    selectionName.textContent = record.name;
    selectionEnter.textContent =
      "Enter " + (record.setting === "house" ? "Memory House" : "Stillwater");
  }
  function clearSelection() {
    selected = undefined;
    selection.hidden = true;
  }
  function addVisitor() {
    const body = mesh(
      new THREE.CapsuleGeometry(0.15, 0.3, 4, 12),
      0x637d73,
      [0, 0.42, 0],
      player,
    );
    body.castShadow = false;
    const head = mesh(
      new THREE.SphereGeometry(0.13, 16, 12),
      0xf2d5ad,
      [0, 0.82, 0],
      player,
    );
    head.castShadow = false;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.22, 0.27, 32),
      new THREE.MeshBasicMaterial({ color: 0xeac77b, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.075;
    player.add(ring);
    scene.add(player);
    player.visible = options.kind !== "sculpture";
  }
  let worldBounds = [-16, 16, -16, 16];
  function blocked(x: number, z: number) {
    return (
      x < worldBounds[0] ||
      x > worldBounds[1] ||
      z < worldBounds[2] ||
      z > worldBounds[3] ||
      (sceneData?.colliders || []).some(
        ([x1, z1, x2, z2]) =>
          x > x1 - 0.18 && x < x2 + 0.18 && z > z1 - 0.18 && z < z2 + 0.18,
      )
    );
  }
  function setPosition(position: THREE.Vector3) {
    if (blocked(position.x, position.z)) return false;
    player.position.copy(position);
    return true;
  }
  function move(dx: number, dz: number) {
    const old = player.position.clone();
    if (!blocked(old.x + dx, old.z)) player.position.x += dx;
    if (!blocked(player.position.x, old.z + dz)) player.position.z += dz;
    if (old.distanceToSquared(player.position) > 0.000001)
      player.rotation.y = Math.atan2(dx, dz);
  }
  function createKeepsake(kind: Placement["kind"], parent: THREE.Group) {
    const cream = 0xe9ddc5,
      wood = 0x73583c;
    if (kind === "Candles") {
      cylinder(0.12, 0.36, cream, [0, 0.2, 0], parent);
      const flame = mesh(
        new THREE.SphereGeometry(0.06, 12, 8),
        0xffbe49,
        [0, 0.43, 0],
        parent,
      );
      flame.scale.set(0.6, 1.8, 0.6);
      (flame.material as THREE.MeshStandardMaterial).emissive.setHex(0xff9c31);
      (flame.material as THREE.MeshStandardMaterial).emissiveIntensity = 2;
    } else if (kind === "Flowers") {
      cylinder(0.16, 0.26, 0xa47362, [0, 0.14, 0], parent);
      for (let i = 0; i < 5; i++) {
        const a = i * 2.4;
        const x = Math.cos(a) * 0.12,
          z = Math.sin(a) * 0.12;
        cylinder(0.012, 0.4, 0x5e7953, [x, 0.45, z], parent);
        mesh(
          new THREE.SphereGeometry(0.08, 8, 6),
          [0xe9ae99, 0xe7d39a, 0xc59cb2][i % 3],
          [x, 0.66, z],
          parent,
        );
      }
    } else if (kind === "Favourite ball")
      mesh(
        new THREE.SphereGeometry(0.17, 18, 12),
        0xb78a50,
        [0, 0.18, 0],
        parent,
      );
    else if (kind === "Memory album") {
      mesh(
        new THREE.BoxGeometry(0.55, 0.09, 0.4),
        0x526a65,
        [0, 0.08, 0],
        parent,
      );
      mesh(
        new THREE.BoxGeometry(0.5, 0.04, 0.35),
        cream,
        [0, 0.085, 0],
        parent,
      );
    } else if (kind === "Blanket")
      mesh(
        new THREE.BoxGeometry(0.8, 0.035, 0.6),
        0x9d779a,
        [0, 0.035, 0],
        parent,
      );
    else if (kind === "Collar & tag") {
      const collar = mesh(
        new THREE.TorusGeometry(0.17, 0.035, 8, 32),
        0x9f6248,
        [0, 0.07, 0],
        parent,
      );
      collar.rotation.x = Math.PI / 2;
      mesh(
        new THREE.SphereGeometry(0.05, 12, 8),
        0xd5aa5b,
        [0, 0.07, 0.2],
        parent,
      );
    } else {
      mesh(new THREE.BoxGeometry(0.42, 0.5, 0.05), wood, [0, 0.28, 0], parent);
      mesh(new THREE.PlaneGeometry(0.34, 0.42), cream, [0, 0.28, 0.03], parent);
    }
  }
  function setArrangement(placements: Placement[]) {
    for (const child of keepsakes.children) {
      const i = interactive.indexOf(child);
      if (i >= 0) interactive.splice(i, 1);
    }
    disposeTree(keepsakes);
    keepsakes.clear();
    for (const p of placements) {
      const group = new THREE.Group();
      group.position.set((p.x - 50) * 0.065, 0.04, (p.y - 50) * 0.065);
      createKeepsake(p.kind, group);
      keepsakes.add(group);
      clickable(group, () =>
        options.onAction(
          p.kind === "Candles"
            ? "candle"
            : p.kind === "Memory album"
              ? "album"
              : "inspect",
        ),
      );
    }
    renderer.shadowMap.needsUpdate = true;
  }
  function actionPlaque(
    title: string,
    position: THREE.Vector3,
    action: () => void,
  ) {
    const sprite = label(title);
    sprite.position.copy(position);
    sprite.scale.multiplyScalar(0.42);
    scene.add(sprite);
    clickable(sprite, action);
  }
  async function initialize() {
    const key =
      options.kind === "village"
        ? "village"
        : options.kind === "sculpture"
          ? "sculpture_" + (m!.style === "photo" ? "photo" : "stylized")
          : m!.theme + "_" + (m!.setting === "house" ? "house" : "garden");
    status.textContent =
      options.kind === "village"
        ? "Opening the village…"
        : "Opening their place…";
    const [environment, data] = await Promise.all([
      load("/models/" + key + ".glb"),
      fetch("/models/" + key + ".json", { signal }).then((r) => {
        if (!r.ok) throw Error("The scene layout could not be loaded.");
        return r.json() as Promise<SceneData>;
      }),
    ]);
    if (disposed) {
      disposeTree(environment);
      return;
    }
    model = environment;
    sceneData = data;
    scene.add(model);
    scene.add(keepsakes);
    model.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.receiveShadow = true;
        o.castShadow = true;
        o.frustumCulled = false;
      }
    });
    addVisitor();
    worldBounds =
      options.kind === "village"
        ? [-19, 19, -19, 19]
        : m?.setting === "house"
          ? [-4.3, 4.3, -3.5, 5]
          : [-6, 6, -4, 6];
    player.position.set(0, 0.06, options.kind === "village" ? 7 : 3);
    if (blocked(player.position.x, player.position.z)) {
      for (let z = 4; z > 0; z -= 0.5)
        if (setPosition(new THREE.Vector3(0, 0.06, z))) break;
    }
    const remembered = sessionStorage.getItem("everleaf-walk:" + key);
    if (remembered) {
      try {
        const p = JSON.parse(remembered);
        if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))
          setPosition(new THREE.Vector3(...(p as [number, number, number])));
      } catch {}
    }
    const sourcePos = new THREE.Vector3(
      ...(data.camera.position as [number, number, number]),
    );
    const sourceTarget = new THREE.Vector3(
      ...(data.camera.target as [number, number, number]),
    );
    const offset = sourcePos.clone().sub(sourceTarget);
    const target =
      options.kind === "village"
        ? player.position.clone().add(new THREE.Vector3(0, 0.7, 0))
        : sourceTarget.clone();
    if (options.kind === "memorial") {
      const eye = sourcePos.clone();
      const start = new THREE.Vector3(
        Math.max(worldBounds[0] + 0.3, Math.min(worldBounds[1] - 0.3, eye.x)),
        0.06,
        Math.max(worldBounds[2] + 0.3, Math.min(worldBounds[3] - 0.3, eye.z)),
      );
      if (!blocked(start.x, start.z)) player.position.copy(start);
      const delta = new THREE.Vector3(
        player.position.x - eye.x,
        0,
        player.position.z - eye.z,
      );
      camera.position.copy(eye).add(delta);
      target.add(delta);
    } else camera.position.copy(target).add(offset);
    controls.target.copy(target);
    camera.zoom = options.kind === "village" ? 1.35 : 1;
    camera.lookAt(target);
    resize();
    if (controls.enabled) controls.update();
    entryPosition.copy(player.position);
    entryCamera.copy(camera.position);
    entryTarget.copy(controls.target);
    entryRotation.copy(camera.quaternion);
    if (options.kind === "village") {
      for (const record of options.records || []) {
        const pos = plotPosition(record.plot_index);
        const marker = new THREE.Group();
        marker.position.copy(pos);
        scene.add(marker);
        const title = document.createElement("button");
        title.className = "world-plot-label";
        title.textContent = record.name;
        title.setAttribute("aria-label", `Select ${record.name}’s memorial`);
        title.addEventListener("click", () => select(record), { signal });
        host.append(title);
        labels.push({
          element: title,
          position: pos.clone().add(new THREE.Vector3(0, 1.4, 0)),
        });
        clickable(marker, () => select(record));
        cylinder(0.48, 0.09, 0xa98a62, [0, 0.03, 0], marker);
        const halo = new THREE.Mesh(
          new THREE.TorusGeometry(0.62, 0.035, 8, 40),
          new THREE.MeshBasicMaterial({
            color:
              record.theme === "C"
                ? 0xbba2d4
                : record.theme === "B"
                  ? 0xe79383
                  : 0xe2ba6c,
          }),
        );
        halo.rotation.x = Math.PI / 2;
        halo.position.y = 0.08;
        marker.add(halo);
        const pet = await petModel(record);
        if (disposed) {
          disposeTree(pet);
          return;
        }
        marker.add(
          fitSculpture(
            pet,
            new THREE.Box3(
              new THREE.Vector3(-0.4, 0.08, -0.4),
              new THREE.Vector3(0.4, 1.05, 0.4),
            ),
            record,
          ),
        );
        if (record.id === options.focus) {
          select(record);
          setPosition(new THREE.Vector3(pos.x, 0.06, pos.z + 1.7));
        }
      }
      const create = label("+ Create a memorial");
      create.position.set(0, 2, 7);
      create.scale.multiplyScalar(1.3);
      scene.add(create);
      clickable(create, options.onCreate);
    } else if (m) {
      const source = model.getObjectByName("pet_sculpture");
      if (source) {
        const targetBox = new THREE.Box3().setFromObject(source);
        source.visible = false;
        const pet = await petModel(m);
        if (disposed) {
          disposeTree(pet);
          return;
        }
        scene.add(fitSculpture(pet, targetBox, m));
        clickable(pet, () => options.onAction("inspect"));
        if (options.kind !== "sculpture")
          actionPlaque(
            "Sculpture",
            new THREE.Vector3(
              targetBox.getCenter(new THREE.Vector3()).x,
              targetBox.max.y + 0.35,
              targetBox.getCenter(new THREE.Vector3()).z,
            ),
            () => options.onAction("inspect"),
          );
      }
      if (m.portrait) {
        const response = await fetch(m.portrait, { signal });
        if (!response.ok)
          throw Error("The saved portrait could not be loaded.");
        const bitmap = await createImageBitmap(await response.blob(), {
          imageOrientation: "flipY",
        });
        if (disposed) {
          bitmap.close();
          return;
        }
        const texture = new THREE.Texture(bitmap);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        texture.flipY = false;
        for (const photo of data.photos) {
          const slot = model.getObjectByName(photo.node);
          if (slot instanceof THREE.Mesh) {
            const mats = Array.isArray(slot.material)
              ? slot.material
              : [slot.material];
            for (const mat of mats) {
              const p = mat as THREE.MeshStandardMaterial;
              p.map?.dispose();
              p.map = texture;
              p.color.set(0xffffff);
              p.needsUpdate = true;
            }
          }
        }
      }
      if (options.kind !== "sculpture") {
        setArrangement(m.arrangement || []);
        actionPlaque("Open memories", new THREE.Vector3(-1.5, 1, 1), () =>
          options.onAction("album"),
        );
        actionPlaque("Light a candle", new THREE.Vector3(1.5, 1, 1), () =>
          options.onAction("candle"),
        );
        actionPlaque("Return to village", new THREE.Vector3(0, 1.4, 4.5), () =>
          options.onAction("village"),
        );
      }
    }
    if (options.kind === "village") {
      const delta = player.position.clone().sub(entryPosition);
      camera.position.add(delta);
      controls.target.add(delta);
      controls.update();
    }
    ready = true;
    status.hidden = true;
    host.dataset.ready = "true";
    renderer.shadowMap.needsUpdate = true;
  }
  function resize() {
    if (disposed) return;
    const w = host.clientWidth,
      h = host.clientHeight;
    renderer.setSize(w, h, false);
    const width = sceneData?.camera.width || 24;
    if (camera instanceof THREE.OrthographicCamera) {
      camera.left = -width / 2;
      camera.right = width / 2;
      camera.top = (width * h) / w / 2;
      camera.bottom = -camera.top;
    } else camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  function isTyping(event: KeyboardEvent) {
    return (event.target as Element)?.matches(
      "input,textarea,select,button,[contenteditable=true]",
    );
  }
  window.addEventListener(
    "keydown",
    (event) => {
      if (!ready || isTyping(event) || options.kind === "sculpture") return;
      const key = event.key.toLowerCase();
      if (
        [
          "w",
          "a",
          "s",
          "d",
          "arrowup",
          "arrowdown",
          "arrowleft",
          "arrowright",
        ].includes(key)
      ) {
        keys.add(key);
        hasDestination.value = false;
        event.preventDefault();
      }
      if (key === "e" && selected) options.onVisit(selected.id);
    },
    { signal },
  );
  window.addEventListener(
    "keyup",
    (event) => keys.delete(event.key.toLowerCase()),
    { signal },
  );
  window.addEventListener("blur", () => keys.clear(), { signal });
  let pointerDown: { x: number; y: number } | null = null;
  let lastPointer: { x: number; y: number } | null = null;
  canvas.addEventListener(
    "pointermove",
    (event) => {
      if (
        options.kind !== "memorial" ||
        !pointerDown ||
        !lastPointer ||
        !event.buttons
      )
        return;
      camera.rotation.y -= (event.clientX - lastPointer.x) * 0.004;
      camera.rotation.x = THREE.MathUtils.clamp(
        camera.rotation.x - (event.clientY - lastPointer.y) * 0.003,
        -1.2,
        1.2,
      );
      lastPointer = { x: event.clientX, y: event.clientY };
    },
    { signal },
  );
  canvas.addEventListener(
    "pointerdown",
    (e) => {
      pointerDown = { x: e.clientX, y: e.clientY };
      lastPointer = { ...pointerDown };
      canvas.setPointerCapture(e.pointerId);
    },
    { signal },
  );
  canvas.addEventListener(
    "pointerup",
    (e) => {
      if (
        !ready ||
        !pointerDown ||
        Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 7
      )
        return;
      pointerDown = null;
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(interactive, true);
      if (hits.length) {
        let object: THREE.Object3D | null = hits[0].object;
        while (object && !object.userData.activate) object = object.parent;
        object?.userData.activate();
        return;
      }
      if (options.kind === "sculpture") return;
      if (
        raycaster.ray.intersectPlane(ground, destination) &&
        !blocked(destination.x, destination.z)
      )
        hasDestination.value = true;
    },
    { signal },
  );
  canvas.addEventListener(
    "pointercancel",
    () => {
      pointerDown = null;
    },
    { signal },
  );
  for (const button of host.querySelectorAll<HTMLElement>("[data-walk-key]")) {
    const key = button.dataset.walkKey!;
    button.addEventListener(
      "pointerdown",
      (e) => {
        e.preventDefault();
        button.setPointerCapture(e.pointerId);
        keys.add(key);
        hasDestination.value = false;
      },
      { signal },
    );
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
      button.addEventListener(name, () => keys.delete(key), { signal });
  }
  for (const button of host.querySelectorAll<HTMLElement>(
    "[data-world-control]",
  ))
    button.addEventListener(
      "click",
      () => {
        switch (button.dataset.worldControl) {
          case "enter":
            if (selected) options.onVisit(selected.id);
            break;
          case "close":
            clearSelection();
            break;
          case "create":
            options.onCreate();
            break;
          case "zoom-in":
            camera.zoom = Math.min(4, camera.zoom * 1.25);
            camera.updateProjectionMatrix();
            break;
          case "zoom-out":
            camera.zoom = Math.max(0.6, camera.zoom / 1.25);
            camera.updateProjectionMatrix();
            break;
          case "reset":
            camera.zoom = options.kind === "village" ? 1.35 : 1;
            camera.updateProjectionMatrix();
            player.position.set(0, 0.06, options.kind === "village" ? 7 : 3);
            hasDestination.value = false;
            break;
        }
      },
      { signal },
    );
  let previousTime = performance.now();
  const lastPlayer = new THREE.Vector3();
  let time = 0;
  function animate() {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    const now = performance.now(),
      dt = Math.min((now - previousTime) / 1000, 0.05);
    previousTime = now;
    time += dt;
    if (ready && options.kind !== "sculpture") {
      lastPlayer.copy(player.position);
      const forward =
        options.kind === "memorial"
          ? camera.getWorldDirection(new THREE.Vector3())
          : new THREE.Vector3().subVectors(controls.target, camera.position);
      forward.y = 0;
      forward.normalize();
      const right = new THREE.Vector3().crossVectors(
        forward,
        new THREE.Vector3(0, 1, 0),
      );
      const dir = new THREE.Vector3();
      if (keys.has("w") || keys.has("arrowup")) dir.add(forward);
      if (keys.has("s") || keys.has("arrowdown")) dir.sub(forward);
      if (keys.has("d") || keys.has("arrowright")) dir.add(right);
      if (keys.has("a") || keys.has("arrowleft")) dir.sub(right);
      if (!dir.lengthSq() && hasDestination.value) {
        dir.subVectors(destination, player.position);
        dir.y = 0;
        if (dir.length() < 0.12) hasDestination.value = false;
      }
      if (dir.lengthSq()) {
        dir.normalize().multiplyScalar(dt * 2.8);
        move(dir.x, dir.z);
        if (lastPlayer.distanceToSquared(player.position) < 0.000001)
          hasDestination.value = false;
      }
      const delta = player.position.clone().sub(lastPlayer);
      camera.position.add(delta);
      controls.target.add(delta);
      player.children[0].position.y =
        0.42 + (delta.lengthSq() ? Math.sin(time * 15) * 0.025 : 0);
    }
    if (controls.enabled) controls.update();
    renderer.render(scene, camera);
    for (const item of labels) {
      const p = item.position.clone().project(camera);
      item.element.hidden =
        Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1 || p.z > 1;
      item.element.style.left = (p.x + 1) * 0.5 * host.clientWidth + "px";
      item.element.style.top = (-p.y + 1) * 0.5 * host.clientHeight + "px";
    }
    if (ready) {
      host.dataset.position = [player.position.x, player.position.z]
        .map((v) => v.toFixed(3))
        .join(",");
      host.dataset.camera = camera.matrixWorld.elements
        .map((v) => v.toFixed(3))
        .join(",");
      host.dataset.drawCalls = String(renderer.info.render.calls);
      host.dataset.triangles = String(renderer.info.render.triangles);
    }
  }
  initialize().catch((error) => {
    if (disposed) return;
    host.dataset.ready = "error";
    status.hidden = false;
    status.textContent =
      error instanceof Error ? error.message : "The 3D scene could not open.";
  });
  animate();
  return {
    setArrangement,
    destroy() {
      if (disposed) return;
      disposed = true;
      host.dataset.ready = "disposed";
      delete host.dataset.triangles;
      abort.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      keys.clear();
      if (ready && options.kind !== "sculpture") {
        const key =
          options.kind === "village"
            ? "village"
            : m!.theme + "_" + (m!.setting === "house" ? "house" : "garden");
        try {
          sessionStorage.setItem(
            "everleaf-walk:" + key,
            JSON.stringify(player.position.toArray()),
          );
        } catch {}
      }
      for (const item of labels) item.element.remove();
      disposeTree(scene);
      renderer.renderLists.dispose();
      canvas.remove();
    },
  };
}
