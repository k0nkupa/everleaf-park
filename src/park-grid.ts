// Infinite Everleaf Park grid (shared by server and browser; no three.js here).
// Garmin's Lantern Bloom tiles: 16x16 m, pivot at tile centre, never rotated.
// Tile (i, j) sits at glTF (16i, 0, -16j). A global plot is (tile i, tile j, plot k).
export const TILE_SIZE = 16;
export const TILE_KINDS = ["base", "alt1", "alt2", "landmark"] as const;
export type TileKind = (typeof TILE_KINDS)[number];
export type GlobalPlot = { i: number; j: number; k: number };
export const PARK_SEED = 0x5eed1eaf;
export const MAX_TILE = 4096;

function hash(i: number, j: number) {
  let h = (PARK_SEED ^ Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
/** Deterministic tile choice: the origin is always a landmark; elsewhere about 1 in 9. */
export function tileKind(i: number, j: number): TileKind {
  if (i === 0 && j === 0) return "landmark";
  const h = hash(i, j);
  if (h % 9 === 0) return "landmark";
  return (["base", "alt1", "alt2"] as const)[(h >>> 8) % 3];
}
export const plotsOn = (kind: TileKind) => (kind === "landmark" ? 12 : 16);
export const tilePlots = (i: number, j: number) => plotsOn(tileKind(i, j));
export const plotKey = (p: GlobalPlot) => `${p.i}:${p.j}:${p.k}`;
export function parsePlotKey(s: unknown): GlobalPlot | null {
  const m = String(s ?? "").match(/^(-?\d+):(-?\d+):(\d+)$/);
  if (!m) return null;
  const p = { i: Number(m[1]), j: Number(m[2]), k: Number(m[3]) };
  return validPlot(p) ? p : null;
}
export const validPlot = (p: GlobalPlot) =>
  [p.i, p.j, p.k].every(Number.isInteger) && Math.abs(p.i) <= MAX_TILE && Math.abs(p.j) <= MAX_TILE && p.k >= 0 && p.k < tilePlots(p.i, p.j);
export const tileOrigin = (i: number, j: number) => ({ x: TILE_SIZE * i, z: -TILE_SIZE * j });
export const tileAt = (x: number, z: number) => ({ i: Math.round(x / TILE_SIZE), j: Math.round(-z / TILE_SIZE) });

/** Tiles in square rings spiralling out from (ci, cj): ring 0, then ring 1, ... */
export function* spiralTiles(ci = 0, cj = 0, maxRing = MAX_TILE) {
  yield { i: ci, j: cj };
  for (let r = 1; r <= maxRing; r++) {
    for (let d = -r + 1; d <= r; d++) yield { i: ci + r, j: cj + d };
    for (let d = r - 1; d >= -r; d--) yield { i: ci + d, j: cj + r };
    for (let d = r - 1; d >= -r; d--) yield { i: ci - r, j: cj + d };
    for (let d = -r + 1; d <= r; d++) yield { i: ci + d, j: cj - r };
  }
}
/** Next free plots, spiralling out from a tile. */
export function freePlots(taken: Set<string>, count: number, ci = 0, cj = 0) {
  const out: GlobalPlot[] = [];
  for (const t of spiralTiles(ci, cj)) {
    for (let k = 0; k < tilePlots(t.i, t.j) && out.length < count; k++) {
      const p = { i: t.i, j: t.j, k };
      if (!taken.has(plotKey(p))) out.push(p);
    }
    if (out.length >= count) break;
  }
  return out;
}
