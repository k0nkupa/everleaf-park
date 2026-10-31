import { many, one, run, statement, batch, takenPlots } from "./db.ts";
import {
  FREE_SCAN_CAP,
  freePlots,
  parsePlotKey,
  plotKey,
  tileKind,
  type GlobalPlot,
} from "./park-grid.ts";
import { HttpError, requireValue, requireUser, getMemorial } from "./domain.ts";
import type { User, Memorial } from "./types.ts";
export const PLOT_COUNT = 36;
export const STONES = ["classic", "arch", "heart", "leaf"] as const;
export type Stone = (typeof STONES)[number];
type Row = Memorial & {
  park_i: number;
  park_j: number;
  park_k: number;
  stone: string | null;
  visits: number | null;
  lights: number | null;
  toys: number | null;
  hidden: number | null;
};
const publicRows = () =>
  many<Row>(
    "SELECT m.*,p.stone,p.visits,p.lights,p.toys,md.hidden FROM memorials m LEFT JOIN park p ON p.memorial_id=m.id LEFT JOIN media md ON md.id=m.portrait_id WHERE m.status='published' AND m.visibility='public' AND m.moderated=0 ORDER BY m.park_j,m.park_i,m.park_k",
  );
const summary = (m: Row) => ({
  id: m.id,
  name: m.name,
  species: m.species,
  born: m.born,
  passed: m.passed,
  message: m.message,
  plot: { i: m.park_i, j: m.park_j, k: m.park_k },
  plot_key: plotKey({ i: m.park_i, j: m.park_j, k: m.park_k }),
  legacy_plot: m.plot_index < PLOT_COUNT ? m.plot_index : null,
  stone: STONES.includes(m.stone as Stone) ? m.stone : "classic",
  portrait: m.portrait_id && !m.hidden ? "/media/" + m.portrait_id : null,
  visits: m.visits || 0,
  lights: m.lights || 0,
  toys: m.toys || 0,
  created_at: m.created_at,
});
export type ParkMemorial = ReturnType<typeof summary>;
const nearTile = (s: string | null) => {
  const m = String(s || "").match(/^(-?\d{1,4}),(-?\d{1,4})$/);
  return m ? { i: Number(m[1]), j: Number(m[2]) } : { i: 0, j: 0 };
};
export async function parkRoute(
  path: string,
  method: string,
  user: User | null,
  visitorKey: string,
  readBody: () => Promise<Record<string, unknown>>,
  query?: URLSearchParams,
): Promise<{ status: number; body: unknown } | null> {
  if (!path.startsWith("/api/park")) return null;
  if (path === "/api/park" && method === "GET") {
    const near = nearTile(query?.get("near") ?? null);
    return {
      status: 200,
      body: {
        stones: STONES,
        near,
        free: freePlots(
          await takenPlots(),
          96,
          near.i,
          near.j,
          FREE_SCAN_CAP,
        ).map((p) => ({ ...p, key: plotKey(p), tile: tileKind(p.i, p.j) })),
        items: (await publicRows()).map(summary),
      },
    };
  }
  const match = path.match(
    /^\/api\/park\/([a-zA-Z0-9-]+)\/(place|visit|light|toy)$/,
  );
  if (!match || method !== "POST")
    throw new HttpError(404, "That action is not available.");
  const [, mid, action] = match;
  if (action === "place") {
    const u = requireUser(user),
      m = await getMemorial(mid, u);
    requireValue(
      m.role === "owner" || m.role === "keeper",
      "Only the keeper can place this memorial.",
    );
    const b = await readBody(),
      stone = String(b.stone || "classic");
    requireValue(STONES.includes(stone as Stone), "Choose a gravestone style.");
    const chosen =
      b.plot === undefined || b.plot === null || b.plot === ""
        ? null
        : parsePlotKey(b.plot);
    requireValue(
      chosen || b.plot === undefined || b.plot === null || b.plot === "",
      "Choose a plot in the park.",
    );
    const near = nearTile(typeof b.near === "string" ? b.near : null);
    for (let attempt = 0; attempt < 5; attempt++) {
      const used = await takenPlots();
      used.delete(plotKey({ i: m.park_i!, j: m.park_j!, k: m.park_k! }));
      const plot = chosen || freePlots(used, 1, near.i, near.j)[0];
      if (!plot || used.has(plotKey(plot)))
        throw new HttpError(409, "That plot was just taken. Choose another.");
      try {
        const result = await batch([
          statement(
            "UPDATE memorials SET park_i=?,park_j=?,park_k=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM memorials WHERE park_i=? AND park_j=? AND park_k=? AND id<>?)",
            plot.i,
            plot.j,
            plot.k,
            mid,
            plot.i,
            plot.j,
            plot.k,
            mid,
          ),
          statement(
            "INSERT INTO park(memorial_id,stone) SELECT ?,? WHERE changes()=1 ON CONFLICT(memorial_id) DO UPDATE SET stone=excluded.stone",
            mid,
            stone,
          ),
        ]);
        if (result[0].meta.changes)
          return {
            status: 200,
            body: { ok: true, plot, plot_key: plotKey(plot) },
          };
      } catch (error) {
        if (!/UNIQUE constraint failed: memorials\.park_/.test(String(error)))
          throw error;
      }
      if (chosen) break;
    }
    throw new HttpError(409, "That plot was just taken. Choose another.");
  }
  const m = (await publicRows()).find((r) => r.id === mid);
  if (!m) throw new HttpError(404, "This memorial is not in the park.");
  const fresh = await run(
    "INSERT OR IGNORE INTO park_actions(memorial_id,visitor,action,day) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM memorials WHERE id=? AND status='published' AND visibility='public' AND moderated=0)",
    mid,
    user?.id || visitorKey,
    action,
    new Date().toISOString().slice(0, 10),
    mid,
  );
  const updated = (await publicRows()).find((r) => r.id === mid);
  if (!updated) throw new HttpError(404, "This memorial is not in the park.");
  return {
    status: 200,
    body: { ...summary(updated), counted: Boolean(fresh.changes) },
  };
}
