import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { dataDir, many, one, run } from "./db.ts";
export function queueFileCleanup(
  files: { path: string; original_path?: string }[],
  userId: string,
) {
  for (const file of files)
    for (const name of [file.path, file.original_path].filter(
      (s): s is string => Boolean(s),
    ))
      run(
        "INSERT OR IGNORE INTO file_cleanup(path,requested_by,created_at) VALUES(?,?,?)",
        name,
        userId,
        Date.now(),
      );
}
export function cleanupCount(userId: string) {
  return one<{ n: number }>(
    "SELECT COUNT(*) n FROM file_cleanup WHERE requested_by=?",
    userId,
  )!.n;
}
let active = false;
export async function retryFileCleanup(userId?: string) {
  if (active) return;
  active = true;
  try {
    const jobs = many<{ path: string }>(
      userId
        ? "SELECT path FROM file_cleanup WHERE requested_by=? LIMIT 1000"
        : "SELECT path FROM file_cleanup LIMIT 1000",
      ...(userId ? [userId] : []),
    );
    for (const job of jobs) {
      try {
        await unlink(resolve(dataDir, "media", job.path));
        run("DELETE FROM file_cleanup WHERE path=?", job.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          run("DELETE FROM file_cleanup WHERE path=?", job.path);
        else
          run(
            "UPDATE file_cleanup SET attempts=attempts+1,error=? WHERE path=?",
            (error as NodeJS.ErrnoException).code || "File removal failed",
            job.path,
          );
      }
    }
  } finally {
    active = false;
  }
}
