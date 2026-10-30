import { canManage } from "./types.ts";
import { queueFileCleanup, retryFileCleanup, cleanupCount } from "./cleanup.ts";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, unlink, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import sharp from "sharp";
import { ZipArchive } from "archiver";
import { db, dataDir, one, many, run, transaction } from "./db.ts";
import { emailConfigured, queueEmail, deliverMail } from "./mail.ts";
import {
  HttpError,
  requireValue,
  requireUser,
  text,
  email,
  choice,
  id,
  getMemorial,
  owner,
  canContribute,
  validateMemorial,
  publicSummary,
  memoriesFor,
  allowedMedia,
  rateLimit,
} from "./domain.ts";
import type {
  User,
  Memorial,
  Media,
  Memory,
  Candle,
  Member,
  Report,
} from "./types.ts";
const port = Number(process.env.PORT || 4880),
  host = process.env.HOST || "127.0.0.1";
const origin = new URL(process.env.APP_ORIGIN || `http://127.0.0.1:${port}`)
  .origin;
const local =
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname) &&
  ["127.0.0.1", "localhost", "::1"].includes(host);
const development = process.env.NODE_ENV !== "production" && local;
if (!development && (!origin.startsWith("https://") || !emailConfigured))
  throw Error(
    "Public mode requires HTTPS APP_ORIGIN and configured Resend sender.",
  );
const preview = process.env.PREVIEW_MODE === "1";
if (preview && (!development || emailConfigured))
  throw Error(
    "Preview mode requires loopback development with email disabled.",
  );
const cookieName = preview ? "everleaf_preview" : "everleaf";
const moderators = (process.env.MODERATOR_EMAILS || "")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim());
const publicDir = resolve("public"),
  hash = (v: string) => createHash("sha256").update(v).digest("hex"),
  token = () => randomBytes(32).toString("hex");
const cookie = (v: string, max = 30 * 86400) =>
  `${cookieName}=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${max}${origin.startsWith("https:") ? "; Secure" : ""}`;
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function session(req: IncomingMessage): User | null {
  const value = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
  const u = one<Omit<User, "moderator">>(
    "SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?",
    hash(value),
    Date.now(),
  );
  return u ? { ...u, moderator: moderators.includes(u.email) } : null;
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
function redirect(
  res: ServerResponse,
  path: string,
  headers: Record<string, string> = {},
) {
  res.writeHead(303, { Location: path, ...headers });
  res.end();
}
async function raw(req: IncomingMessage, max: number) {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    total += b.length;
    if (total > max)
      throw new HttpError(413, "That file or request is too large.");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await raw(req, 1024 * 1024);
  try {
    const b = JSON.parse(bytes.toString() || "{}");
    requireValue(
      b && typeof b === "object" && !Array.isArray(b),
      "Send an object.",
    );
    return b;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "The request could not be read.");
  }
}
function moderation(user: User | null) {
  const u = requireUser(user);
  if (!u.moderator) throw new HttpError(403, "Moderator access is required.");
  return u;
}
const nextPath = (v: unknown) =>
  typeof v === "string" &&
  v.startsWith("/#/") &&
  v.length < 300 &&
  !/[\r\n]/.test(v)
    ? v
    : "/#/home";
function memoryMedia(value: unknown, m: Memorial, u: User) {
  requireValue(
    Array.isArray(value) && value.length <= 8,
    "Attach up to eight photographs.",
  );
  return value.map((v) => {
    requireValue(typeof v === "string", "Choose a photograph.");
    const file = one<Media>(
      "SELECT * FROM media WHERE id=? AND memorial_id=?",
      v,
      m.id,
    );
    requireValue(
      file &&
        file.purpose === "album" &&
        (file.user_id === u.id || canManage(m)),
      "Choose your own memory photographs.",
    );
    return v;
  });
}
async function discardUploadFiles(
  files: { path: string; original_path?: string }[],
  userId: string,
) {
  transaction(() => queueFileCleanup(files, userId));
  await retryFileCleanup(userId);
}
function ownedMedia(m: Memorial, u: User) {
  return many<Media>(
    canManage(m)
      ? "SELECT * FROM media WHERE memorial_id=? ORDER BY created_at"
      : "SELECT * FROM media WHERE memorial_id=? AND user_id=? AND hidden=0 ORDER BY created_at",
    ...(canManage(m) ? [m.id] : [m.id, u.id]),
  );
}
async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", origin),
    path = decodeURIComponent(url.pathname),
    method = req.method || "GET",
    user = session(req),
    ip = req.socket.remoteAddress || "unknown";
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
    req.headers.origin !== origin
  )
    throw new HttpError(403, "Reload the page before submitting this request.");
  if (path === "/api/health" && method === "GET")
    return send(res, 200, { ok: true });
  if (path === "/api/cleanup") {
    const u = requireUser(user);
    if (method === "POST") await retryFileCleanup(u.id);
    if (method === "POST" || method === "GET")
      return send(res, 200, { pending: cleanupCount(u.id) });
  }
  if (path === "/api/session" && method === "GET")
    return send(res, 200, { user, emailConfigured, development, preview });
  if (path === "/api/preview/session" && method === "POST") {
    if (!preview) throw new HttpError(404, "Not found.");
    if (user) return send(res, 200, { user });
    rateLimit("preview-session:" + ip, 30);
    const b = await body(req),
      name = text(b.name || "Keeper", "Your name", 80, true),
      uid = id(),
      secret = token();
    transaction(() => {
      run(
        "INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)",
        uid,
        uid + "@preview.invalid",
        name,
        Date.now(),
      );
      run(
        "INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)",
        hash(secret),
        uid,
        Date.now() + 30 * 86400000,
      );
    });
    res.setHeader("Set-Cookie", cookie(secret));
    return send(res, 201, {
      user: {
        id: uid,
        name,
        email: uid + "@preview.invalid",
        moderator: false,
      },
    });
  }
  if (path === "/api/auth/request" && method === "POST") {
    rateLimit("login-ip:" + ip, 20);
    const b = await body(req),
      address = email(b.email);
    rateLimit("login-email:" + address, 5);
    const name = text(b.name || address.split("@")[0], "Your name", 80, true),
      value = token(),
      expires = Date.now() + 20 * 60 * 1000;
    run(
      "INSERT INTO logins(hash,email,name,next,expires_at) VALUES(?,?,?,?,?)",
      hash(value),
      address,
      name,
      nextPath(b.next),
      expires,
    );
    const loginUrl = origin + "/auth/verify?token=" + value;
    const mail = queueEmail(
      address,
      "Your Everleaf sign-in link",
      `Sign in to Everleaf:\n${loginUrl}\n\nThis link expires in 20 minutes and can be used once. If you did not request it, ignore this email.`,
    );
    void deliverMail(mail);
    return send(res, 202, {
      message: emailConfigured
        ? "Your sign-in link has been requested. Check your inbox."
        : "Your local sign-in link is ready.",
      ...(development && !emailConfigured ? { loginUrl } : {}),
      emailConfigured,
    });
  }
  if (path === "/auth/verify" && method === "GET") {
    const v = url.searchParams.get("token") || "",
      login = one<{ expires_at: number }>(
        "SELECT expires_at FROM logins WHERE hash=?",
        hash(v),
      );
    if (!login || login.expires_at < Date.now())
      return redirect(res, "/#/login?error=expired");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in — Everleaf</title><link rel="stylesheet" href="/site.css"><body class="auth-confirm"><main class="panel"><h1>Welcome to Everleaf.</h1><p>Continue to your memorials.</p><form method="post" action="/auth/verify"><input type="hidden" name="token" value="${esc(v)}"><button class="btn p" id="confirm-login">Sign in</button></form></main></body></html>`,
    );
    return;
  }
  if (path === "/auth/verify" && method === "POST") {
    const form = new URLSearchParams((await raw(req, 4096)).toString()),
      v = form.get("token") || "";
    const result = transaction(() => {
      const login = one<{
        email: string;
        name: string;
        next: string;
        expires_at: number;
      }>("SELECT * FROM logins WHERE hash=?", hash(v));
      if (!login || login.expires_at < Date.now())
        throw new HttpError(
          400,
          "This sign-in link has expired or was already used.",
        );
      run("DELETE FROM logins WHERE hash=?", hash(v));
      let u = one<User>("SELECT * FROM users WHERE email=?", login.email);
      if (!u) {
        const uid = id();
        run(
          "INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)",
          uid,
          login.email,
          login.name,
          Date.now(),
        );
        u = one<User>("SELECT * FROM users WHERE id=?", uid)!;
      }
      const secret = token();
      run(
        "INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)",
        hash(secret),
        u.id,
        Date.now() + 30 * 86400000,
      );
      return { secret, next: login.next };
    });
    return redirect(res, result.next, { "Set-Cookie": cookie(result.secret) });
  }
  if (path === "/api/logout" && method === "POST") {
    const v = req.headers.cookie?.match(
      new RegExp("(?:^|;\\s*)" + cookieName + "=([a-f0-9]{64})"),
    )?.[1];
    if (v) run("DELETE FROM sessions WHERE hash=?", hash(v));
    res.setHeader("Set-Cookie", cookie("", 0));
    return send(res, 200, { ok: true });
  }
  if (path === "/api/memorials" && method === "GET") {
    const mine = url.searchParams.get("mine") === "1";
    if (mine) {
      const u = requireUser(user);
      const rows = many<Memorial & { member_role: string }>(
        "SELECT DISTINCT m.*,a.role member_role FROM memorials m LEFT JOIN members a ON a.memorial_id=m.id AND a.email=? AND a.status='accepted' WHERE m.owner_id=? OR (a.id IS NOT NULL AND (a.role='keeper' OR (m.status='published' AND m.moderated=0))) ORDER BY m.updated_at DESC",
        u.email,
        u.id,
      );
      return send(res, 200, {
        items: rows.map((m) => ({
          ...publicSummary(m),
          status: m.status,
          visibility: m.visibility,
          version: m.version,
          role: m.owner_id === u.id ? "owner" : m.member_role,
          moderated: Boolean(m.moderated),
          pending:
            m.owner_id === u.id || m.member_role === "keeper"
              ? one<{ n: number }>(
                  "SELECT COUNT(*) n FROM memories WHERE memorial_id=? AND status='pending'",
                  m.id,
                )!.n
              : 0,
        })),
      });
    }
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80),
      species = url.searchParams.get("species") || "",
      theme = url.searchParams.get("theme") || "";
    const rows = many<Memorial>(
      "SELECT * FROM memorials WHERE status='published' AND visibility='public' AND moderated=0 AND instr(lower(name),lower(?))>0 AND (?='' OR species=?) AND (?='' OR theme=?) ORDER BY updated_at DESC LIMIT 200",
      q,
      species,
      species,
      theme,
      theme,
    );
    return send(res, 200, { items: rows.map(publicSummary) });
  }
  if (path === "/api/memorials" && method === "POST") {
    const u = requireUser(user);
    rateLimit("create:" + u.id, 30, 86400000);
    const b = validateMemorial(await body(req)),
      mid = id(),
      now = Date.now();
    transaction(() => {
      run(
        "INSERT INTO memorials(id,owner_id,name,species,born,passed,message,theme,setting,style,finish,visibility,review,arrangement,created_at,updated_at,plot_index) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        mid,
        u.id,
        b.name,
        b.species,
        b.born,
        b.passed,
        b.message,
        b.theme,
        b.setting,
        b.style,
        b.finish,
        b.visibility,
        Number(b.review),
        JSON.stringify(b.arrangement),
        now,
        now,
        one<{ n: number }>(
          "SELECT COALESCE(MAX(plot_index),-1)+1 n FROM memorials",
        )!.n,
      );
    });
    return send(res, 201, getMemorial(mid, u));
  }
  const match = path.match(/^\/api\/memorials\/([a-zA-Z0-9-]+)(?:\/(.*))?$/);
  if (match) {
    const [, mid, action = ""] = match;
    if (!action && method === "GET") {
      const m = getMemorial(mid, user),
        memories = memoriesFor(m, user),
        files = user ? ownedMedia(m, user) : [];
      const contributors = [
        ...new Set(
          memories
            .filter(
              (v) => v.show_name && ["approved", "family"].includes(v.status),
            )
            .map((v) => v.author),
        ),
      ].map((name) => ({ name }));
      const candles = many<Candle>(
        "SELECT * FROM candles WHERE memorial_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 100",
        mid,
        Date.now(),
      ).map((c) => ({
        ...c,
        anonymous: Boolean(c.anonymous),
        author: c.anonymous ? "Anonymous" : c.author,
        user_id: c.user_id === user?.id ? c.user_id : "",
      }));
      return send(res, 200, {
        ...m,
        portrait:
          m.portrait_id &&
          (canManage(m) ||
            !one<{ hidden: number }>(
              "SELECT hidden FROM media WHERE id=?",
              m.portrait_id,
            )?.hidden)
            ? "/media/" + m.portrait_id
            : null,
        media: files.map((f) => ({
          ...f,
          path: undefined,
          original_path: undefined,
        })),
        memories,
        candles,
        contributors,
      });
    }
    if (!action && method === "PATCH") {
      const m = owner(mid, user),
        b = await body(req),
        v = validateMemorial(b);
      requireValue(Number.isInteger(b.version), "Reload the saved memorial.");
      if (b.status !== undefined)
        choice(
          b.status,
          ["draft", "published", "archived"],
          "publication state",
        );
      const status = b.status || m.status;
      requireValue(
        !(m.status === "archived" && status === "published"),
        "Restore to a draft and review visibility before publishing.",
      );
      if (status === "published") {
        requireValue(
          m.portrait_id,
          "Choose a public portrait before publishing.",
        );
        requireValue(!m.moderated, "This memorial is under moderation review.");
      }
      const updated = run(
        "UPDATE memorials SET name=?,species=?,born=?,passed=?,message=?,theme=?,setting=?,style=?,finish=?,visibility=?,review=?,arrangement=?,status=?,version=version+1,updated_at=? WHERE id=? AND version=?",
        v.name,
        v.species,
        v.born,
        v.passed,
        v.message,
        v.theme,
        v.setting,
        v.style,
        v.finish,
        v.visibility,
        Number(v.review),
        JSON.stringify(v.arrangement),
        status as string,
        Date.now(),
        mid,
        b.version as number,
      );
      if (!updated.changes)
        throw new HttpError(
          409,
          "This memorial changed in another tab. Your input is still here; reload the saved version before trying again.",
        );
      return send(res, 200, getMemorial(mid, user));
    }
    if (!action && method === "DELETE") {
      const m = owner(mid, user),
        b = await body(req);
      if (m.role !== "owner")
        throw new HttpError(
          403,
          "Only the original owner can permanently delete this memorial.",
        );
      requireValue(
        b.confirm === m.name,
        "Type the pet’s name exactly to confirm deletion.",
      );
      const files = many<Media>("SELECT * FROM media WHERE memorial_id=?", mid);
      transaction(() => {
        run("DELETE FROM mail WHERE context_id=?", mid);
        queueFileCleanup(files, requireUser(user).id);
        run("DELETE FROM memorials WHERE id=?", mid);
      });
      await retryFileCleanup(requireUser(user).id);
      return send(res, 200, {
        deleted: true,
        cleanupPending: cleanupCount(requireUser(user).id) > 0,
      });
    }
    if (action === "media" && method === "POST") {
      const u = requireUser(user),
        m = getMemorial(mid, u);
      canContribute(m, u);
      rateLimit("upload:" + u.id, 100, 3600000);
      const purpose = choice(
        url.searchParams.get("purpose"),
        ["portrait", "album", "reference"],
        "photo purpose",
      );
      if (purpose !== "album" && !canManage(m))
        throw new HttpError(
          403,
          "Only the owner can change portraits or reference photographs.",
        );
      requireValue(
        many("SELECT id FROM media WHERE memorial_id=?", mid).length < 250,
        "This memorial has reached its 250-photo limit.",
      );
      const content = req.headers["content-type"] || "";
      requireValue(
        ["image/jpeg", "image/png", "image/webp"].includes(content),
        "Choose a JPG, PNG or WebP photo.",
      );
      const bytes = await raw(req, 25 * 1024 * 1024);
      let normalized: Buffer, format: string;
      try {
        const input = sharp(bytes, {
            limitInputPixels: 40000000,
            failOn: "error",
          }),
          metadata = await input.metadata();
        requireValue(
          ["jpeg", "png", "webp"].includes(metadata.format),
          "Choose a JPG, PNG or WebP photo.",
        );
        format = metadata.format === "jpeg" ? "jpg" : metadata.format;
        if (purpose === "portrait") {
          const zoom = Number(url.searchParams.get("zoom") || 1),
            x = Number(url.searchParams.get("x") || 0.5),
            y = Number(url.searchParams.get("y") || 0.5);
          requireValue(
            [zoom, x, y].every(Number.isFinite) &&
              zoom >= 1 &&
              zoom <= 3 &&
              x >= 0 &&
              x <= 1 &&
              y >= 0 &&
              y <= 1,
            "Choose a valid portrait frame.",
          );
          const rotated = await input
              .rotate()
              .toBuffer({ resolveWithObject: true }),
            side = Math.max(
              1,
              Math.floor(
                Math.min(rotated.info.width, rotated.info.height) / zoom,
              ),
            );
          normalized = await sharp(rotated.data)
            .extract({
              left: Math.floor((rotated.info.width - side) * x),
              top: Math.floor((rotated.info.height - side) * y),
              width: side,
              height: side,
            })
            .resize({
              width: 1024,
              height: 1024,
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({ quality: 88 })
            .toBuffer();
        } else
          normalized = await input
            .rotate()
            .resize({
              width: 2400,
              height: 2400,
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({ quality: 88 })
            .toBuffer();
      } catch {
        throw new HttpError(
          400,
          "This photo could not be read. Choose a JPG, PNG or WebP under 40 megapixels.",
        );
      }
      const fid = id(),
        file = fid + ".jpg",
        original = fid + ".original." + format,
        filename = text(
          url.searchParams.get("filename") || "Photograph",
          "File name",
          150,
          true,
        );
      try {
        await writeFile(resolve(dataDir, "media", file), normalized, {
          mode: 0o600,
        });
        await writeFile(resolve(dataDir, "media", original), bytes, {
          mode: 0o600,
        });
      } catch (e) {
        await discardUploadFiles(
          [{ path: file, original_path: original }],
          u.id,
        );
        throw e;
      }
      try {
        transaction(() => {
          run(
            "INSERT INTO media(id,memorial_id,user_id,purpose,filename,path,original_path,bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            fid,
            mid,
            u.id,
            purpose,
            filename,
            file,
            original,
            normalized.length,
            Date.now(),
          );
          if (purpose === "portrait")
            run(
              "UPDATE memorials SET portrait_id=?,version=version+1,updated_at=? WHERE id=?",
              fid,
              Date.now(),
              mid,
            );
        });
      } catch (e) {
        await discardUploadFiles(
          [{ path: file, original_path: original }],
          u.id,
        );
        throw e;
      }
      return send(res, 201, { id: fid, url: "/media/" + fid, purpose });
    }
    if (action.startsWith("media/") && method === "DELETE") {
      const u = requireUser(user),
        m = getMemorial(mid, u),
        file = one<Media>(
          "SELECT * FROM media WHERE id=? AND memorial_id=?",
          action.slice(6),
          mid,
        );
      if (!file) throw new HttpError(404, "Photo not found.");
      if (!canManage(m) && file.user_id !== u.id)
        throw new HttpError(403, "You cannot remove this photo.");
      requireValue(
        file.id !== m.portrait_id || m.status !== "published",
        "Choose another portrait before removing the published portrait.",
      );
      requireValue(
        !many<{ media_ids: string }>(
          "SELECT media_ids FROM memories WHERE memorial_id=?",
          mid,
        ).some((v) => (JSON.parse(v.media_ids) as string[]).includes(file.id)),
        "Remove this photo from its memory before deleting it.",
      );
      transaction(() => {
        run(
          "UPDATE memorials SET portrait_id=NULL,version=version+1 WHERE portrait_id=?",
          file.id,
        );
        queueFileCleanup([file], u.id);
        run("DELETE FROM media WHERE id=?", file.id);
      });
      await retryFileCleanup(u.id);
      return send(res, 200, {
        deleted: true,
        cleanupPending: cleanupCount(u.id) > 0,
      });
    }
    if (action === "portrait" && method === "POST") {
      const m = owner(mid, user),
        b = await body(req),
        file = one<Media>(
          "SELECT * FROM media WHERE id=? AND memorial_id=? AND purpose=?",
          String(b.media_id),
          mid,
          "portrait",
        );
      requireValue(file, "Choose an uploaded portrait.");
      requireValue(
        b.version === m.version,
        "Reload the saved memorial before changing its portrait.",
      );
      run(
        "UPDATE memorials SET portrait_id=?,version=version+1 WHERE id=?",
        file.id,
        mid,
      );
      return send(res, 200, getMemorial(mid, user));
    }
    if (action === "memories" && method === "POST") {
      const u = requireUser(user),
        m = getMemorial(mid, u);
      canContribute(m, u);
      rateLimit("memory:" + u.id, 50, 3600000);
      const b = await body(req),
        mediaIds = memoryMedia(b.media_ids || [], m, u),
        memoryId = id(),
        now = Date.now();
      const status = canManage(m) || !m.review ? "approved" : "pending";
      run(
        "INSERT INTO memories(id,memorial_id,user_id,author,show_name,title,story,date,media_ids,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        memoryId,
        mid,
        u.id,
        u.name,
        Number(b.show_name === true),
        text(b.title, "Title", 100, true),
        text(b.story, "Memory", 10000, true),
        text(b.date || "", "Date", 60),
        JSON.stringify(mediaIds),
        status,
        now,
        now,
      );
      return send(res, 201, { id: memoryId, status });
    }
    if (action.startsWith("memories/")) {
      const u = requireUser(user),
        m = getMemorial(mid, u),
        memory = one<Memory>(
          "SELECT * FROM memories WHERE id=? AND memorial_id=?",
          action.slice(9),
          mid,
        );
      if (!memory) throw new HttpError(404, "Memory not found.");
      if (method === "DELETE") {
        if (!canManage(m) && memory.user_id !== u.id)
          throw new HttpError(
            403,
            "Only its author or the owner can remove this memory.",
          );
        run("DELETE FROM memories WHERE id=?", memory.id);
        return send(res, 200, { deleted: true });
      }
      if (method === "PATCH") {
        const b = await body(req);
        if (b.decision) {
          owner(mid, u);
          const decision = choice(
            b.decision,
            ["approved", "family", "declined"],
            "review decision",
          );
          requireValue(
            memory.status !== "hidden",
            "This memory is hidden by moderation.",
          );
          run(
            "UPDATE memories SET status=?,updated_at=? WHERE id=?",
            decision,
            Date.now(),
            memory.id,
          );
          const author = one<User>(
            "SELECT * FROM users WHERE id=?",
            memory.user_id,
          )!;
          queueEmail(
            author.email,
            `Your memory of ${m.name}`,
            `Your memory “${memory.title}” was ${decision}.\n${origin}/#/m/${mid}`,
            mid,
          );
          void deliverMail();
          return send(res, 200, { status: decision });
        }
        if (!canManage(m) && memory.user_id !== u.id)
          throw new HttpError(
            403,
            "Only its author or the owner can edit this memory.",
          );
        canContribute(m, u);
        requireValue(
          memory.status !== "hidden",
          "This memory is hidden by moderation.",
        );
        const hiddenIds = (
          JSON.parse(memory.media_ids as unknown as string) as string[]
        ).filter(
          (fid) =>
            one<{ hidden: number }>(
              "SELECT hidden FROM media WHERE id=? AND memorial_id=?",
              fid,
              mid,
            )?.hidden,
        );
        const mediaIds = [
          ...new Set([...memoryMedia(b.media_ids || [], m, u), ...hiddenIds]),
        ];
        requireValue(
          mediaIds.length <= 8,
          "Attach up to eight photographs, including those hidden during review.",
        );
        const status =
          memory.status === "family"
            ? "family"
            : canManage(m) || !m.review
              ? "approved"
              : "pending";
        run(
          "UPDATE memories SET title=?,story=?,date=?,media_ids=?,status=?,show_name=?,updated_at=? WHERE id=?",
          text(b.title, "Title", 100, true),
          text(b.story, "Memory", 10000, true),
          text(b.date || "", "Date", 60),
          JSON.stringify(mediaIds),
          status,
          Number(
            memory.user_id === u.id
              ? b.show_name === true
              : Boolean(memory.show_name),
          ),
          Date.now(),
          memory.id,
        );
        return send(res, 200, { status });
      }
    }
    if (action === "candles" && method === "POST") {
      const u = requireUser(user),
        m = getMemorial(mid, u);
      canContribute(m, u);
      const b = await body(req);
      requireValue(
        typeof b.anonymous === "boolean",
        "Choose whether to show your name.",
      );
      const existing = one<Candle>(
        "SELECT * FROM candles WHERE memorial_id=? AND user_id=?",
        mid,
        u.id,
      );
      if (existing && existing.expires_at > Date.now())
        return send(res, 200, { id: existing.id, alreadyLit: true });
      const now = Date.now(),
        cid = id();
      run(
        "INSERT OR REPLACE INTO candles(id,memorial_id,user_id,author,anonymous,message,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
        cid,
        mid,
        u.id,
        u.name,
        Number(b.anonymous),
        text(b.message || "", "Tribute", 500),
        now,
        now + 7 * 86400000,
      );
      return send(res, 201, { id: cid });
    }
    if (action.startsWith("candles/") && method === "DELETE") {
      const u = requireUser(user),
        m = getMemorial(mid, u),
        c = one<Candle>(
          "SELECT * FROM candles WHERE id=? AND memorial_id=?",
          action.slice(8),
          mid,
        );
      if (!c) throw new HttpError(404, "Candle not found.");
      if (!canManage(m) && c.user_id !== u.id)
        throw new HttpError(
          403,
          "Only the contributor or owner can remove this candle.",
        );
      run("DELETE FROM candles WHERE id=?", c.id);
      return send(res, 200, { deleted: true });
    }
    if (action === "members" && method === "GET") {
      owner(mid, user);
      return send(res, 200, {
        items: many<Member>(
          "SELECT m.*,i.expires_at FROM members m LEFT JOIN invitations i ON i.member_id=m.id WHERE m.memorial_id=? ORDER BY m.created_at",
          mid,
        ),
      });
    }
    if (action === "members" && method === "POST") {
      const u = requireUser(user),
        m = owner(mid, u),
        b = await body(req),
        address = email(b.email),
        role = choice(
          b.role,
          ["contributor", "viewer", "keeper"],
          "access level",
        );
      requireValue(
        address !== u.email &&
          address !==
            one<User>("SELECT * FROM users WHERE id=?", m.owner_id)?.email,
        "This person already manages this memorial.",
      );
      rateLimit("invite:" + u.id, 30, 3600000);
      const value = token(),
        memberId = id();
      transaction(() => {
        const old = one<Member>(
          "SELECT * FROM members WHERE memorial_id=? AND email=?",
          mid,
          address,
        );
        if (old?.status === "accepted")
          throw new HttpError(
            409,
            "This person already has access. Change their role instead.",
          );
        if ((role === "keeper" || old?.role === "keeper") && m.role !== "owner")
          throw new HttpError(
            403,
            "Only the original owner can assign co-keepers.",
          );
        if (old) run("DELETE FROM members WHERE id=?", old.id);
        run(
          "INSERT INTO members(id,memorial_id,email,role,status,created_at) VALUES(?,?,?,?,?,?)",
          memberId,
          mid,
          address,
          role,
          "invited",
          Date.now(),
        );
        run(
          "INSERT INTO invitations(hash,member_id,expires_at) VALUES(?,?,?)",
          hash(value),
          memberId,
          Date.now() + 7 * 86400000,
        );
      });
      const inviteUrl = origin + "/#/invite/" + value;
      const mail = queueEmail(
        address,
        `An invitation to remember ${m.name}`,
        `${u.name} invited you to ${m.name}’s memorial as a ${role}. Sign in with this email and accept within seven days:\n${inviteUrl}`,
        mid,
      );
      void deliverMail(mail);
      return send(res, 201, {
        id: memberId,
        ...(development && !emailConfigured ? { inviteUrl } : {}),
      });
    }
    if (action.startsWith("members/") && method === "PATCH") {
      const m = owner(mid, user),
        member = one<Member>(
          "SELECT * FROM members WHERE id=? AND memorial_id=?",
          action.slice(8),
          mid,
        );
      if (!member) throw new HttpError(404, "Member not found.");
      const b = await body(req),
        role = choice(
          b.role,
          ["viewer", "contributor", "keeper"],
          "access level",
        );
      if ((member.role === "keeper" || role === "keeper") && m.role !== "owner")
        throw new HttpError(
          403,
          "Only the original owner can change co-keeper access.",
        );
      run("UPDATE members SET role=? WHERE id=?", role, member.id);
      return send(res, 200, { role });
    }
    if (action.startsWith("members/") && method === "DELETE") {
      const m = owner(mid, user),
        member = one<Member>(
          "SELECT * FROM members WHERE id=? AND memorial_id=?",
          action.slice(8),
          mid,
        );
      if (member?.role === "keeper" && m.role !== "owner")
        throw new HttpError(
          403,
          "Only the original owner can revoke a co-keeper.",
        );
      run(
        "DELETE FROM members WHERE id=? AND memorial_id=?",
        action.slice(8),
        mid,
      );
      return send(res, 200, { revoked: true });
    }
    if (action === "export" && method === "GET") {
      const m = owner(mid, user),
        files = many<Media>("SELECT * FROM media WHERE memorial_id=?", mid),
        memories = memoriesFor(m, user);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="everleaf-memorial.zip"',
        "Cache-Control": "no-store",
      });
      const zip = new ZipArchive({ zlib: { level: 5 } });
      zip.on("error", () => res.destroy());
      zip.on("warning", () => res.destroy());
      res.on("close", () => zip.abort());
      zip.pipe(res);
      zip.append(
        JSON.stringify(
          {
            ...m,
            memories,
            media: files.map((f) => ({
              ...f,
              path: undefined,
              original_path: undefined,
            })),
          },
          null,
          2,
        ),
        { name: "memorial.json" },
      );
      for (const file of files) {
        zip.file(resolve(dataDir, "media", file.path), {
          name: "photos/" + file.id + ".jpg",
        });
        zip.file(resolve(dataDir, "media", file.original_path), {
          name: "originals/" + file.id + extname(file.original_path),
        });
      }
      zip.append(
        "Your memorial export includes written content, original uploaded files and metadata-stripped display photos. The supplied sculpture catalogue and scene backgrounds remain part of Everleaf.\n",
        { name: "README.txt" },
      );
      void zip.finalize().catch(() => res.destroy());
      return;
    }
  }
  if (path.startsWith("/api/invitations/")) {
    const u = requireUser(user),
      value = path.slice(17),
      invite = one<{
        id: string;
        memorial_id: string;
        email: string;
        role: string;
        expires_at: number;
      }>(
        "SELECT m.*,i.expires_at FROM invitations i JOIN members m ON m.id=i.member_id WHERE i.hash=?",
        hash(value),
      );
    if (!invite || invite.expires_at < Date.now())
      throw new HttpError(404, "This invitation has expired or been revoked.");
    if (invite.email !== u.email)
      throw new HttpError(
        403,
        "Sign in with the email address that received this invitation.",
      );
    const m = one<Memorial>(
      "SELECT * FROM memorials WHERE id=?",
      invite.memorial_id,
    )!;
    if (method === "GET")
      return send(res, 200, {
        name: m.name,
        role: invite.role,
        memorial_id: m.id,
      });
    if (method === "POST") {
      transaction(() => {
        run(
          "UPDATE members SET status='accepted',name=? WHERE id=?",
          u.name,
          invite.id,
        );
        run("DELETE FROM invitations WHERE hash=?", hash(value));
      });
      return send(res, 200, { memorial_id: m.id });
    }
  }
  if (path === "/api/reports" && method === "POST") {
    const u = requireUser(user),
      b = await body(req),
      m = getMemorial(String(b.memorial_id), u);
    requireValue(m.status === "published", "Report a published memorial.");
    rateLimit("report:" + u.id, 20, 3600000);
    const memoryId = b.memory_id ? String(b.memory_id) : null;
    if (memoryId)
      requireValue(
        memoriesFor(m, u).some(
          (v) => v.id === memoryId && ["approved", "family"].includes(v.status),
        ),
        "Choose a visible memory to report.",
      );
    const rid = id();
    run(
      "INSERT INTO reports(id,memorial_id,memory_id,reporter_id,reason,detail,created_at) VALUES(?,?,?,?,?,?,?)",
      rid,
      m.id,
      memoryId,
      u.id,
      choice(b.reason, ["inappropriate", "privacy", "other"], "report reason"),
      text(b.detail, "Report details", 3000, true),
      Date.now(),
    );
    return send(res, 201, { id: rid });
  }
  if (path === "/api/reports" && method === "GET") {
    moderation(user);
    const reports = many<
      Report & { media_ids: string | null; portrait_id: string | null }
    >(
      "SELECT r.*,m.name memorial_name,m.portrait_id,e.title memory_title,e.story memory_story,e.media_ids FROM reports r LEFT JOIN memorials m ON m.id=r.memorial_id LEFT JOIN memories e ON e.id=r.memory_id ORDER BY r.created_at DESC LIMIT 200",
    );
    return send(res, 200, {
      items: reports.map((r) => ({
        ...r,
        media: (r.memory_id
          ? (JSON.parse(r.media_ids || "[]") as string[])
          : r.portrait_id
            ? [r.portrait_id]
            : []
        )
          .map((fid) =>
            one<Media>("SELECT id,filename,hidden FROM media WHERE id=?", fid),
          )
          .filter(Boolean),
      })),
    });
  }
  if (path.match(/^\/api\/reports\/[a-zA-Z0-9-]+$/) && method === "PATCH") {
    const u = moderation(user),
      rid = path.split("/").at(-1)!,
      report = one<Report>("SELECT * FROM reports WHERE id=?", rid);
    if (!report) throw new HttpError(404, "Report not found.");
    const b = await body(req),
      action = choice(
        b.action,
        [
          "hide_memory",
          "restore_memory",
          "hide_photo",
          "restore_photo",
          "remove_memory",
          "hide_memorial",
          "restore_memorial",
          "dismiss",
        ],
        "moderation action",
      ),
      reason = text(b.reason, "Decision reason", 2000, true);
    if (action === "hide_memory" || action === "remove_memory")
      requireValue(
        report.memory_id,
        "This report does not reference a memory.",
      );
    if (action === "hide_memorial" || action === "restore_memorial")
      requireValue(report.memorial_id, "The memorial has been deleted.");
    const targetMemory = report.memory_id
      ? one<Memory & { previous_status: string | null }>(
          "SELECT * FROM memories WHERE id=?",
          report.memory_id,
        )
      : undefined;
    let photoId: string | null = null;
    if (action === "restore_memory")
      requireValue(
        targetMemory && targetMemory.status === "hidden",
        "Choose a hidden memory to restore.",
      );
    if (action === "hide_photo" || action === "restore_photo") {
      requireValue(
        typeof b.media_id === "string",
        "Choose the reported photograph.",
      );
      const file = one<Media>(
        "SELECT * FROM media WHERE id=? AND memorial_id=?",
        b.media_id,
        report.memorial_id!,
      );
      const belongs = targetMemory
        ? (
            JSON.parse(targetMemory.media_ids as unknown as string) as string[]
          ).includes(b.media_id)
        : one<Memorial>(
            "SELECT * FROM memorials WHERE id=?",
            report.memorial_id!,
          )?.portrait_id === b.media_id;
      requireValue(
        file && file.purpose !== "reference" && belongs,
        "Choose a photograph attached to this reported item.",
      );
      photoId = file.id;
    }
    transaction(() => {
      if (action === "hide_photo" || action === "restore_photo")
        run(
          "UPDATE media SET hidden=? WHERE id=?",
          action === "hide_photo" ? 1 : 0,
          photoId!,
        );
      if (action === "restore_memory")
        run(
          "UPDATE memories SET status=?,previous_status=NULL,updated_at=? WHERE id=?",
          targetMemory!.previous_status || "approved",
          Date.now(),
          report.memory_id!,
        );
      if (action === "hide_memory")
        run(
          "UPDATE memories SET previous_status=CASE WHEN status='hidden' THEN previous_status ELSE status END,status='hidden',updated_at=? WHERE id=?",
          Date.now(),
          report.memory_id!,
        );
      if (action === "remove_memory")
        run("DELETE FROM memories WHERE id=?", report.memory_id!);
      if (action === "hide_memorial" || action === "restore_memorial")
        run(
          "UPDATE memorials SET moderated=?,version=version+1 WHERE id=?",
          action === "hide_memorial" ? 1 : 0,
          report.memorial_id!,
        );
      run(
        "UPDATE reports SET status=?,decision=? WHERE id=?",
        action === "dismiss" ? "dismissed" : "actioned",
        action + ": " + reason,
        rid,
      );
      run(
        "INSERT INTO audit(id,user_id,report_id,action,reason,target_id,created_at) VALUES(?,?,?,?,?,?,?)",
        id(),
        u.id,
        rid,
        action,
        reason,
        photoId || report.memory_id || report.memorial_id,
        Date.now(),
      );
    });
    if (report.memorial_id) {
      const recipient = one<{ email: string }>(
        "SELECT u.email FROM users u JOIN memorials m ON m.owner_id=u.id WHERE m.id=?",
        report.memorial_id,
      );
      if (recipient)
        queueEmail(
          recipient.email,
          "An update about your Everleaf memorial",
          `Moderation decision: ${action.replaceAll("_", " ")}\nReason: ${reason}`,
          report.memorial_id,
        );
      const reporter = one<User>(
        "SELECT * FROM users WHERE id=?",
        report.reporter_id,
      );
      if (reporter)
        queueEmail(
          reporter.email,
          "Your Everleaf report was reviewed",
          "Your report was reviewed and a decision was recorded.",
          report.memorial_id,
        );
      void deliverMail();
    }
    return send(res, 200, { action, reason });
  }
  if (path.startsWith("/media/") && method === "GET") {
    const file = one<Media>("SELECT * FROM media WHERE id=?", path.slice(7));
    if (!file) throw new HttpError(404, "Photo not found.");
    allowedMedia(file, user);
    const bytes = await readFile(resolve(dataDir, "media", file.path));
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": bytes.length,
      "Cache-Control": "private, no-store",
    });
    res.end(bytes);
    return;
  }
  if (path.startsWith("/api/"))
    throw new HttpError(404, "That action is not available.");
  if (method !== "GET" && method !== "HEAD")
    throw new HttpError(405, "This request method is not supported.");
  const target = resolve(publicDir, path === "/" ? "index.html" : "." + path);
  if (
    !target.startsWith(publicDir + sep) ||
    path.split("/").some((s) => s.startsWith("."))
  )
    throw new HttpError(404, "Not found.");
  let bytes: Buffer;
  try {
    const info = await stat(target);
    if (!info.isFile()) throw Error();
    bytes = await readFile(target);
  } catch {
    throw new HttpError(404, "Not found.");
  }
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ttf": "font/ttf",
    ".svg": "image/svg+xml",
    ".glb": "model/gltf-binary",
    ".json": "application/json",
  };
  res.writeHead(200, {
    "Content-Type": mime[extname(target)] || "application/octet-stream",
    "Cache-Control":
      development || extname(target) === ".html"
        ? "no-store"
        : "public, max-age=3600",
  });
  res.end(method === "HEAD" ? undefined : bytes);
}
const server = createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; font-src 'self'; connect-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  route(req, res).catch((error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500)
      console.error(
        "Request failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
    send(res, status, {
      error:
        status === 500
          ? "We could not complete that action. Your input has been kept."
          : error.message,
    });
  });
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(port, host, () =>
  console.log(
    `Everleaf: ${origin}${development ? " (local development)" : ""}`,
  ),
);
void retryFileCleanup();
const fileTimer = setInterval(() => void retryFileCleanup(), 60000);
fileTimer.unref();
const mailTimer = setInterval(() => void deliverMail(), 60000);
mailTimer.unref();
const cleanup = setInterval(() => {
  run("DELETE FROM sessions WHERE expires_at<?", Date.now());
  run("DELETE FROM logins WHERE expires_at<?", Date.now());
  run("DELETE FROM rate_limits WHERE until_at<?", Date.now());
}, 3600000);
cleanup.unref();
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    clearInterval(mailTimer);
    clearInterval(fileTimer);
    clearInterval(cleanup);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
