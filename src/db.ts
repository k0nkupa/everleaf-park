import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { freePlots, plotKey } from "./park-grid.ts";
export const dataDir = resolve(process.env.DATA_DIR || ".data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
mkdirSync(resolve(dataDir, "media"), { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(resolve(dataDir, "everleaf.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS logins(hash TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,next TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memorials(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,species TEXT NOT NULL,born TEXT NOT NULL DEFAULT '',passed TEXT NOT NULL DEFAULT '',message TEXT NOT NULL DEFAULT '',theme TEXT NOT NULL DEFAULT 'A',setting TEXT NOT NULL DEFAULT 'house',style TEXT NOT NULL DEFAULT 'stylized',finish TEXT NOT NULL DEFAULT 'glaze',visibility TEXT NOT NULL DEFAULT 'private',review INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'draft',moderated INTEGER NOT NULL DEFAULT 0,portrait_id TEXT,arrangement TEXT NOT NULL DEFAULT '[]',version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,memorial_id TEXT NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),purpose TEXT NOT NULL,filename TEXT NOT NULL,path TEXT NOT NULL,original_path TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,memorial_id TEXT NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),author TEXT NOT NULL,title TEXT NOT NULL,story TEXT NOT NULL,date TEXT NOT NULL DEFAULT '',media_ids TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS candles(id TEXT PRIMARY KEY,memorial_id TEXT NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),author TEXT NOT NULL,anonymous INTEGER NOT NULL,message TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,UNIQUE(memorial_id,user_id));
CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,memorial_id TEXT NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,email TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',role TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(memorial_id,email));
CREATE TABLE IF NOT EXISTS invitations(hash TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,memorial_id TEXT REFERENCES memorials(id) ON DELETE SET NULL,memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,reporter_id TEXT NOT NULL REFERENCES users(id),reason TEXT NOT NULL,detail TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',decision TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,report_id TEXT,action TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mail(id TEXT PRIMARY KEY,context_id TEXT,to_email TEXT NOT NULL,subject TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS file_cleanup(path TEXT PRIMARY KEY,requested_by TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS public_memorials ON memorials(status,visibility,updated_at);
CREATE INDEX IF NOT EXISTS memorial_memories ON memories(memorial_id,status);
CREATE INDEX IF NOT EXISTS memorial_media ON media(memorial_id);
CREATE INDEX IF NOT EXISTS member_email ON members(email,status);`);
export const one = <T>(sql: string, ...args: SQLInputValue[]) =>
  db.prepare(sql).get(...args) as T | undefined;
export const many = <T>(sql: string, ...args: SQLInputValue[]) =>
  db.prepare(sql).all(...args) as T[];
export const run = (sql: string, ...args: SQLInputValue[]) =>
  db.prepare(sql).run(...args);
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Additive migrations preserve existing memorials and keep names private until consent is given.
for (const [table, definition] of [
  ["memories", "show_name INTEGER NOT NULL DEFAULT 0"],
  ["memories", "previous_status TEXT"],
  ["media", "hidden INTEGER NOT NULL DEFAULT 0"],
  ["audit", "target_id TEXT"],
  ["memorials", "plot_index INTEGER"],
  ["memorials", "park_i INTEGER"],
  ["memorials", "park_j INTEGER"],
  ["memorials", "park_k INTEGER"],
] as const) {
  const column = definition.split(" ")[0];
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

transaction(() => {
  let next = one<{ n: number }>(
    "SELECT COALESCE(MAX(plot_index),-1)+1 n FROM memorials",
  )!.n;
  for (const m of many<{ id: string }>(
    "SELECT id FROM memorials WHERE plot_index IS NULL ORDER BY created_at,id",
  ))
    run("UPDATE memorials SET plot_index=? WHERE id=?", next++, m.id);
  run(
    "CREATE UNIQUE INDEX IF NOT EXISTS memorial_plot ON memorials(plot_index)",
  );
  // Infinite park: a global plot (tile i, tile j, plot k). Rows from the closed
  // park keep plot_index and get a park plot by spiralling out from the origin
  // in their old plot order, so existing memorials stay in the same sequence.
  run(
    "CREATE UNIQUE INDEX IF NOT EXISTS memorial_park_plot ON memorials(park_i,park_j,park_k)",
  );
  assignParkPlots();
});

/** Give every memorial without a park plot the next free one from the origin. */
export function assignParkPlots(onlyPublic = false) {
  const missing = many<{ id: string }>(
    `SELECT id FROM memorials WHERE park_k IS NULL${onlyPublic ? " AND status='published' AND visibility='public'" : ""} ORDER BY plot_index,created_at,id`,
  );
  if (!missing.length) return;
  const taken = new Set(
    many<{ i: number; j: number; k: number }>(
      "SELECT park_i i,park_j j,park_k k FROM memorials WHERE park_k IS NOT NULL",
    ).map(plotKey),
  );
  const free = freePlots(taken, missing.length);
  missing.forEach((m, n) =>
    run(
      "UPDATE memorials SET park_i=?,park_j=?,park_k=? WHERE id=?",
      free[n].i,
      free[n].j,
      free[n].k,
      m.id,
    ),
  );
}
