import { randomUUID } from "node:crypto";
import { one, many } from "./db.ts";
import {
  THEMES,
  canManage,
  SPECIES,
  FINISHES,
  KEEPSAKES,
  type User,
  type Memorial,
  type Memory,
  type Media,
  type Placement,
} from "./types.ts";
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new HttpError(400, message);
}
export function text(
  value: unknown,
  label: string,
  max: number,
  required = false,
) {
  requireValue(typeof value === "string", `${label} must be text.`);
  const result = value.trim();
  requireValue(
    result.length <= max && (!required || result.length > 0),
    `${label} must be ${required ? "1–" : "at most "}${max} characters.`,
  );
  return result;
}
export function email(value: unknown) {
  const result = text(value, "Email", 254, true).toLowerCase();
  requireValue(
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result),
    "Enter a valid email address.",
  );
  return result;
}
export function choice<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  requireValue(
    typeof value === "string" && values.includes(value as T),
    `Choose a valid ${label}.`,
  );
  return value as T;
}
export function requireUser(user: User | null): User {
  if (!user) throw new HttpError(401, "Sign in to continue.");
  return user;
}
export async function getMemorial(id: string, user: User | null) {
  const m = await one<Memorial>("SELECT * FROM memorials WHERE id=?", id);
  if (!m) throw new HttpError(404, "This memorial is not available.");
  m.review = Boolean(m.review);
  m.moderated = Boolean(m.moderated);
  m.arrangement = JSON.parse(m.arrangement as unknown as string);
  m.role =
    user?.id === m.owner_id
      ? "owner"
      : user
        ? (
            await one<{
              role: "viewer" | "contributor" | "keeper";
            }>(
              "SELECT role FROM members WHERE memorial_id=? AND user_id=? AND status='accepted'",
              id,
              user.id,
            )
          )?.role || null
        : null;
  if (!m.role && (m.status !== "published" || m.visibility === "private"))
    throw new HttpError(404, "This memorial is private or not available.");
  if (m.status === "draft" && !canManage(m))
    throw new HttpError(404, "This memorial is not available.");
  if (m.moderated && !canManage(m))
    throw new HttpError(404, "This memorial is under review.");
  if (m.status === "archived" && !canManage(m))
    throw new HttpError(404, "This memorial is resting.");
  return m;
}
export async function owner(id: string, user: User | null) {
  const u = requireUser(user),
    m = await getMemorial(id, u);
  if (!canManage(m))
    throw new HttpError(403, "Only the owner or a co-keeper can do that.");
  return m;
}
export function canContribute(m: Memorial, user: User | null) {
  requireUser(user);
  if (m.status === "archived" || (m.status !== "published" && !canManage(m)))
    throw new HttpError(403, "This memorial is not accepting contributions.");
  if (m.role === "viewer")
    throw new HttpError(403, "Your invitation allows visits only.");
}
export function validateMemorial(b: Record<string, unknown>) {
  const born = text(b.born ?? "", "Birth date", 40),
    passed = text(b.passed ?? "", "Passed date", 40),
    year = (s: string) => s.match(/\b(1[89]\d{2}|20\d{2}|2100)\b/)?.[0];
  requireValue(!born || year(born), "Include a four-digit birth year.");
  requireValue(
    !passed || year(passed),
    "Include a four-digit year for when they passed.",
  );
  for (const date of [born, passed])
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const parsed = new Date(date + "T00:00:00Z");
      requireValue(
        Number.isFinite(parsed.getTime()) &&
          parsed.toISOString().slice(0, 10) === date,
        "Enter a real calendar date.",
      );
      requireValue(
        date <= new Date().toISOString().slice(0, 10),
        "Dates cannot be in the future.",
      );
    }
  requireValue(
    !/^\d{4}-\d{2}-\d{2}$/.test(born) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(passed) ||
      born <= passed,
    "The date they passed cannot be before their birth date.",
  );
  requireValue(
    !year(born) || !year(passed) || Number(year(born)) <= Number(year(passed)),
    "The year they passed cannot be before their birth year.",
  );
  requireValue(
    [born, passed].every(
      (d) => !year(d) || Number(year(d)) <= new Date().getFullYear(),
    ),
    "Dates cannot be in the future.",
  );
  const arrangement = b.arrangement ?? [];
  requireValue(
    Array.isArray(arrangement) && arrangement.length <= 24,
    "Use at most 24 keepsakes.",
  );
  const items: Placement[] = arrangement.map((p) => {
    requireValue(p && typeof p === "object", "Choose a keepsake.");
    const { kind, x, y } = p as Placement;
    return {
      kind: choice(kind, KEEPSAKES, "keepsake"),
      x: bounded(x),
      y: bounded(y),
    };
  });
  requireValue(
    typeof b.review === "boolean",
    "Choose whether contributions need review.",
  );
  return {
    name: text(b.name, "Name", 80, true),
    species: choice(
      b.species,
      Object.keys(SPECIES) as (keyof typeof SPECIES)[],
      "species",
    ),
    born,
    passed,
    message: text(b.message ?? "", "Remembrance", 500),
    theme: choice(
      b.theme,
      Object.keys(THEMES) as (keyof typeof THEMES)[],
      "theme",
    ),
    setting: choice(b.setting, ["house", "garden"], "setting"),
    style: choice(b.style, ["stylized", "photo"], "sculpture style"),
    finish: choice(
      b.finish,
      Object.keys(FINISHES) as (keyof typeof FINISHES)[],
      "finish",
    ),
    visibility: choice(
      b.visibility,
      ["public", "link", "private"],
      "visibility",
    ),
    review: b.review,
    arrangement: items,
  };
}
function bounded(value: unknown) {
  requireValue(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 5 &&
      value <= 95,
    "Keep objects within the scene.",
  );
  return Math.round(value * 10) / 10;
}
export function publicSummary(
  m: Memorial & { portrait_hidden: number | null },
) {
  return {
    id: m.id,
    plot_index: m.plot_index,
    name: m.name,
    species: m.species,
    born: m.born,
    passed: m.passed,
    message: m.message,
    theme: m.theme,
    setting: m.setting,
    style: m.style,
    finish: m.finish,
    portrait:
      m.portrait_id && !m.portrait_hidden ? `/media/${m.portrait_id}` : null,
  };
}
export async function memoriesFor(m: Memorial, user: User | null) {
  const manager = canManage(m),
    family = Boolean(m.role);
  const visible = manager
    ? "1=1"
    : family
      ? "(status IN ('approved','family') OR user_id=?)"
      : "(status='approved' OR user_id=?)";
  const rows = await many<Memory>(
    `SELECT * FROM memories WHERE memorial_id=? AND ${visible} ORDER BY created_at DESC`,
    ...(manager ? [m.id] : [m.id, user?.id || ""]),
  );
  const hidden = new Set(
    (
      await many<{ id: string }>(
        "SELECT id FROM media WHERE memorial_id=? AND hidden=1",
        m.id,
      )
    ).map((v) => v.id),
  );
  return rows.map((v) => {
    const allIds = JSON.parse(v.media_ids as unknown as string) as string[];
    const visibleIds = manager
      ? allIds
      : allIds.filter((fid) => !hidden.has(fid));
    return {
      ...v,
      show_name: Boolean(v.show_name),
      author:
        v.show_name || manager || v.user_id === user?.id
          ? v.author
          : "Anonymous",
      media_ids: visibleIds,
      hidden_media_count: allIds.length - visibleIds.length,
    };
  });
}
export async function allowedMedia(file: Media, user: User | null) {
  if (user?.moderator && file.purpose !== "reference") {
    const reported = await many<{
      media_ids: string | null;
      portrait_id: string | null;
      memory_id: string | null;
    }>(
      "SELECT e.media_ids,m.portrait_id,r.memory_id FROM reports r JOIN memorials m ON m.id=r.memorial_id LEFT JOIN memories e ON e.id=r.memory_id WHERE r.memorial_id=?",
      file.memorial_id,
    );
    if (
      reported.some((r) =>
        r.memory_id
          ? (JSON.parse(r.media_ids || "[]") as string[]).includes(file.id)
          : r.portrait_id === file.id,
      )
    )
      return;
  }
  const m = await getMemorial(file.memorial_id, user);
  if (canManage(m)) return;
  if (file.hidden)
    throw new HttpError(
      404,
      "This photograph is hidden while moderation reviews it.",
    );
  if (user?.id === file.user_id) return;
  if (file.purpose === "portrait" && m.portrait_id === file.id) return;
  if (
    file.purpose === "album" &&
    (await memoriesFor(m, user)).some((v) => v.media_ids.includes(file.id))
  )
    return;
  throw new HttpError(404, "This photograph is private or not available.");
}
export async function rateLimit(
  key: string,
  max: number,
  window = 15 * 60 * 1000,
) {
  const now = Date.now();
  const result = await one<{ count: number }>(
    "INSERT INTO rate_limits(key,count,until_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN until_at<=? THEN 1 ELSE count+1 END,until_at=CASE WHEN until_at<=? THEN ? ELSE until_at END WHERE until_at<=? OR count<? RETURNING count",
    key,
    now + window,
    now,
    now,
    now + window,
    now,
    max,
  );
  if (!result)
    throw new HttpError(429, "Please wait a little before trying again.");
}
export const id = () => randomUUID();
