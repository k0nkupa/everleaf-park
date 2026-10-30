import { randomUUID } from "node:crypto";
import { one, many, run } from "./db.ts";
import {
  THEMES,
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
export function getMemorial(id: string, user: User | null): Memorial {
  const m = one<Memorial>("SELECT * FROM memorials WHERE id=?", id);
  if (!m) throw new HttpError(404, "This memorial is not available.");
  m.review = Boolean(m.review);
  m.moderated = Boolean(m.moderated);
  m.arrangement = JSON.parse(m.arrangement as unknown as string);
  m.role =
    user?.id === m.owner_id
      ? "owner"
      : user
        ? one<{ role: "viewer" | "contributor" }>(
            "SELECT role FROM members WHERE memorial_id=? AND email=? AND status='accepted'",
            id,
            user.email,
          )?.role || null
        : null;
  if (!m.role && (m.status !== "published" || m.visibility === "private"))
    throw new HttpError(404, "This memorial is private or not available.");
  if (m.moderated && m.role !== "owner")
    throw new HttpError(404, "This memorial is under review.");
  if (m.status === "archived" && m.role !== "owner")
    throw new HttpError(404, "This memorial is resting.");
  return m;
}
export function owner(id: string, user: User | null) {
  const u = requireUser(user),
    m = getMemorial(id, u);
  if (m.role !== "owner")
    throw new HttpError(403, "Only the memorial owner can do that.");
  return m;
}
export function canContribute(m: Memorial, user: User | null) {
  requireUser(user);
  if (m.status !== "published" && m.role !== "owner")
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
export function publicSummary(m: Memorial) {
  return {
    id: m.id,
    name: m.name,
    species: m.species,
    born: m.born,
    passed: m.passed,
    message: m.message,
    theme: m.theme,
    setting: m.setting,
    style: m.style,
    finish: m.finish,
    portrait: m.portrait_id ? `/media/${m.portrait_id}` : null,
  };
}
export function memoriesFor(m: Memorial, user: User | null) {
  return many<Memory>(
    `SELECT * FROM memories WHERE memorial_id=? AND ${m.role === "owner" ? "1=1" : "(status='approved' OR user_id=?)"} ORDER BY created_at DESC`,
    ...(m.role === "owner" ? [m.id] : [m.id, user?.id || ""]),
  ).map((v) => ({
    ...v,
    media_ids: JSON.parse(v.media_ids as unknown as string),
  }));
}
export function allowedMedia(file: Media, user: User | null) {
  if (user?.id === file.user_id) return;
  const m = getMemorial(file.memorial_id, user);
  if (m.role === "owner") return;
  if (file.purpose === "portrait" && m.portrait_id === file.id) return;
  const approved = many<{ media_ids: string }>(
    "SELECT media_ids FROM memories WHERE memorial_id=? AND status='approved'",
    m.id,
  );
  if (
    file.purpose === "album" &&
    approved.some((v) =>
      (JSON.parse(v.media_ids) as string[]).includes(file.id),
    )
  )
    return;
  throw new HttpError(404, "This photograph is private or not available.");
}
export function rateLimit(key: string, max: number, window = 15 * 60 * 1000) {
  const now = Date.now();
  const r = one<{ count: number; until_at: number }>(
    "SELECT * FROM rate_limits WHERE key=?",
    key,
  );
  if (r && r.until_at > now && r.count >= max)
    throw new HttpError(429, "Please wait a little before trying again.");
  if (!r || r.until_at <= now)
    run(
      "INSERT OR REPLACE INTO rate_limits(key,count,until_at) VALUES(?,1,?)",
      key,
      now + window,
    );
  else run("UPDATE rate_limits SET count=count+1 WHERE key=?", key);
}
export const id = () => randomUUID();
