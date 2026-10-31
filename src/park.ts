// Everleaf Park: shared-park layer over the existing memorial records.
// Adds gravestone style + visit/light/toy counters without changing memorial rows.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { db, dataDir, one, many, run, transaction } from "./db.ts";
import { HttpError, requireValue, requireUser, getMemorial } from "./domain.ts";
import type { User, Memorial } from "./types.ts";

export const PLOT_COUNT = 36;
export const STONES = ["classic", "arch", "heart", "leaf"] as const;
export type Stone = (typeof STONES)[number];

db.exec(`CREATE TABLE IF NOT EXISTS park(memorial_id TEXT PRIMARY KEY REFERENCES memorials(id) ON DELETE CASCADE,stone TEXT NOT NULL DEFAULT 'classic',visits INTEGER NOT NULL DEFAULT 0,lights INTEGER NOT NULL DEFAULT 0,toys INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS park_actions(memorial_id TEXT NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,visitor TEXT NOT NULL,action TEXT NOT NULL,day TEXT NOT NULL,PRIMARY KEY(memorial_id,visitor,action,day));`);

type Row = Memorial & { stone: string | null; visits: number | null; lights: number | null; toys: number | null; hidden: number | null };
const publicRows = () =>
  many<Row>(
    "SELECT m.*,p.stone,p.visits,p.lights,p.toys,md.hidden FROM memorials m LEFT JOIN park p ON p.memorial_id=m.id LEFT JOIN media md ON md.id=m.portrait_id WHERE m.status='published' AND m.visibility='public' AND m.moderated=0 ORDER BY m.plot_index",
  );
const summary = (m: Row) => ({
  id: m.id,
  name: m.name,
  species: m.species,
  born: m.born,
  passed: m.passed,
  message: m.message,
  plot: m.plot_index,
  stone: (STONES as readonly string[]).includes(m.stone || "") ? m.stone : "classic",
  portrait: m.portrait_id && !m.hidden ? "/media/" + m.portrait_id : null,
  visits: m.visits || 0,
  lights: m.lights || 0,
  toys: m.toys || 0,
  created_at: m.created_at,
});
export type ParkMemorial = ReturnType<typeof summary>;

const taken = () => new Set(many<{ p: number }>("SELECT plot_index p FROM memorials").map((r) => r.p));

export async function parkRoute(
  path: string,
  method: string,
  user: User | null,
  visitorKey: string,
  readBody: () => Promise<Record<string, unknown>>,
): Promise<{ status: number; body: unknown } | null> {
  if (!path.startsWith("/api/park")) return null;
  if (path === "/api/park" && method === "GET") {
    const used = taken();
    return {
      status: 200,
      body: {
        plots: PLOT_COUNT,
        stones: STONES,
        free: [...Array(PLOT_COUNT).keys()].filter((i) => !used.has(i)),
        items: publicRows().filter((m) => m.plot_index < PLOT_COUNT).map(summary),
      },
    };
  }
  const match = path.match(/^\/api\/park\/([a-zA-Z0-9-]+)\/(place|visit|light|toy)$/);
  if (!match || method !== "POST") throw new HttpError(404, "That action is not available.");
  const [, mid, action] = match;
  if (action === "place") {
    // Owner chooses gravestone style and a free plot.
    const u = requireUser(user),
      m = getMemorial(mid, u);
    requireValue(m.role === "owner" || m.role === "keeper", "Only the keeper can place this memorial.");
    const b = await readBody(),
      plot = Number(b.plot),
      stone = String(b.stone || "classic");
    requireValue((STONES as readonly string[]).includes(stone), "Choose a gravestone style.");
    requireValue(Number.isInteger(plot) && plot >= 0 && plot < PLOT_COUNT, "Choose a plot in the park.");
    transaction(() => {
      const owner = one<{ id: string }>("SELECT id FROM memorials WHERE plot_index=?", plot);
      requireValue(!owner || owner.id === mid, "That plot was just taken. Choose another.");
      run("UPDATE memorials SET plot_index=? WHERE id=?", plot, mid);
      run("INSERT INTO park(memorial_id,stone) VALUES(?,?) ON CONFLICT(memorial_id) DO UPDATE SET stone=excluded.stone", mid, stone);
    });
    return { status: 200, body: { ok: true } };
  }
  const m = publicRows().find((r) => r.id === mid);
  if (!m) throw new HttpError(404, "This memorial is not in the park.");
  const col = action === "visit" ? "visits" : action === "light" ? "lights" : "toys";
  // One count per visitor per action per day keeps counters meaningful.
  const fresh = run(
    "INSERT OR IGNORE INTO park_actions(memorial_id,visitor,action,day) VALUES(?,?,?,?)",
    mid, user?.id || visitorKey, action, new Date().toISOString().slice(0, 10),
  ).changes;
  if (fresh) run(`INSERT INTO park(memorial_id,${col}) VALUES(?,1) ON CONFLICT(memorial_id) DO UPDATE SET ${col}=${col}+1`, mid);
  return { status: 200, body: { ...summary(publicRows().find((r) => r.id === mid)!), counted: Boolean(fresh) } };
}

// Demo memorials for the local preview so the park is never empty.
const DEMOS: [string, Memorial["species"], string, string, Stone, string, string][] = [
  ["Biscuit", "dog", "2011", "2025", "classic", "#d9a066", "Chased every leaf in the yard."],
  ["Miso", "cat", "2014", "2026", "arch", "#8f8f99", "Sunbeam expert, lap inspector."],
  ["Pepper", "dog", "2009", "2024", "heart", "#3b302a", "Never missed a walk."],
  ["Clover", "rabbit", "2019", "2026", "leaf", "#c9b8a0", "Small paws, big heart."],
  ["Kiwi", "bird", "2016", "2025", "arch", "#7fbf6a", "Sang the kettle song every morning."],
  ["Mango", "cat", "2012", "2026", "leaf", "#e08a3a", "Ruled the windowsill."],
  ["Toby", "guinea", "2020", "2024", "classic", "#a56b45", "Wheeked for every carrot."],
  ["Hazel", "dog", "2013", "2026", "heart", "#b8875a", "Best friend on the beach."],
];
const DEMO_PLOTS = [1, 4, 8, 13, 19, 22, 28, 33];
export async function seedDemo() {
  if (one<{ n: number }>("SELECT COUNT(*) n FROM memorials")!.n > 0) return;
  const uid = "demo-keeper", now = Date.now();
  run("INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES(?,?,?,?)", uid, "demo@preview.invalid", "Everleaf demo", now);
  for (const [i, [name, species, born, passed, stone, color, message]] of DEMOS.entries()) {
    const mid = "demo-" + name.toLowerCase(), fid = "demo-portrait-" + name.toLowerCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><radialGradient id="g" cx=".5" cy=".4"><stop offset="0" stop-color="#fff6e6"/><stop offset="1" stop-color="#e9d3ad"/></radialGradient></defs><rect width="512" height="512" fill="url(#g)"/><ellipse cx="256" cy="300" rx="150" ry="130" fill="${color}"/><circle cx="256" cy="210" r="105" fill="${color}"/><circle cx="215" cy="200" r="13" fill="#2b211b"/><circle cx="297" cy="200" r="13" fill="#2b211b"/><ellipse cx="256" cy="240" rx="18" ry="12" fill="#2b211b"/><text x="256" y="470" font-family="sans-serif" font-size="44" text-anchor="middle" fill="#5a3e28">${name}</text></svg>`;
    const jpg = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
    await writeFile(resolve(dataDir, "media", fid + ".jpg"), jpg, { mode: 0o600 });
    transaction(() => {
      run("INSERT INTO memorials(id,owner_id,name,species,born,passed,message,visibility,status,review,plot_index,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'public','published',0,?,?,?)",
        mid, uid, name, species, born, passed, message, DEMO_PLOTS[i], now - i * 86400000, now - i * 86400000);
      run("INSERT INTO media(id,memorial_id,user_id,purpose,filename,path,original_path,bytes,created_at) VALUES(?,?,?,'portrait',?,?,?,?,?)",
        fid, mid, uid, name + ".jpg", fid + ".jpg", fid + ".jpg", jpg.length, now);
      run("UPDATE memorials SET portrait_id=? WHERE id=?", fid, mid);
      run("INSERT INTO park(memorial_id,stone,visits,lights,toys) VALUES(?,?,?,?,?)", mid, stone, 3 + i * 4, 1 + (i % 4), i % 3);
    });
  }
}
