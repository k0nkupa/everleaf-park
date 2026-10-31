import { randomUUID } from "node:crypto";
import { many, one, run, statement } from "./db.ts";
import { current } from "./runtime.ts";
export function queueFileCleanup(
  files: { path: string; original_path?: string }[],
  userId: string,
) {
  return files.flatMap((file) =>
    [file.path, file.original_path]
      .filter((v): v is string => Boolean(v))
      .map((name) =>
        statement(
          "INSERT OR IGNORE INTO file_cleanup(path,requested_by,created_at) VALUES(?,?,?)",
          name,
          userId,
          Date.now(),
        ),
      ),
  );
}
export async function cleanupCount(userId: string) {
  return (await one<{ n: number }>(
    "SELECT COUNT(*) n FROM file_cleanup WHERE requested_by=?",
    userId,
  ))!.n;
}
export async function retryFileCleanup(userId?: string) {
  const lease = randomUUID(),
    now = Date.now();
  const jobs = await many<{ path: string }>(
    "UPDATE file_cleanup SET lease_token=?,lease_until=? WHERE path IN (SELECT path FROM file_cleanup WHERE lease_until<=?" +
      (userId ? " AND requested_by=?" : "") +
      " ORDER BY created_at LIMIT 1000) RETURNING path",
    lease,
    now + 60000,
    now,
    ...(userId ? [userId] : []),
  );
  if (!jobs.length) return;
  try {
    await current().env.BUCKET.delete(jobs.map((job) => job.path));
    await run("DELETE FROM file_cleanup WHERE lease_token=?", lease);
  } catch {
    await run(
      "UPDATE file_cleanup SET attempts=attempts+1,error='File removal failed',lease_token=NULL,lease_until=0 WHERE lease_token=?",
      lease,
    );
  }
}
