import { canManage } from "./types.ts";
import { queueFileCleanup, retryFileCleanup, cleanupCount } from "./cleanup.ts";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { httpServerHandler } from "cloudflare:node";
import { pipeline } from "node:stream/promises";
import { current } from "./runtime.ts";
import { memorialExport } from "./export.ts";
import { one, many, run, statement, batch, nextFreePlot } from "./db.ts";
import { parkRoute } from "./park.ts";
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
const hash = (v: string) => createHash("sha256").update(v).digest("hex"),
  token = () => randomBytes(32).toString("hex");
async function session(req: IncomingMessage): Promise<User | null> {
  const uid = req.headers["oai-authenticated-user-id"],
    address = req.headers["oai-authenticated-user-email"];
  if (
    typeof uid !== "string" ||
    typeof address !== "string" ||
    !uid ||
    !address
  )
    return null;
  const authenticatedEmail = email(address);
  let name = authenticatedEmail;
  const full = req.headers["oai-authenticated-user-full-name"];
  if (typeof full === "string") {
    try {
      name =
        req.headers["oai-authenticated-user-full-name-encoding"] ===
        "percent-encoded-utf-8"
          ? decodeURIComponent(full)
          : full;
    } catch {}
  }
  name = name.trim().slice(0, 80) || authenticatedEmail.split("@")[0];
  await run(
    "INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name WHERE users.email<>excluded.email OR users.name<>excluded.name",
    uid,
    authenticatedEmail,
    name,
    Date.now(),
  );
  const moderators = (current().env.MODERATOR_EMAILS || "")
    .toLowerCase()
    .split(",")
    .map((v) => v.trim());
  return {
    id: uid,
    email: authenticatedEmail,
    name,
    moderator: moderators.includes(authenticatedEmail),
  };
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function raw(req: AsyncIterable<Uint8Array>, max: number) {
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
async function memoryMedia(value: unknown, m: Memorial, u: User) {
  requireValue(
    Array.isArray(value) && value.length <= 8,
    "Attach up to eight photographs.",
  );
  requireValue(
    value.every((v) => typeof v === "string"),
    "Choose a photograph.",
  );
  const ids = value as string[];
  if (!ids.length) return [];
  const files = await many<Media>(
    `SELECT * FROM media WHERE memorial_id=? AND id IN (${ids.map(() => "?").join(",")})`,
    m.id,
    ...ids,
  );
  return ids.map((fid) => {
    const file = files.find((f) => f.id === fid);
    requireValue(
      file &&
        file.purpose === "album" &&
        (file.user_id === u.id || canManage(m)),
      "Choose your own memory photographs.",
    );
    return fid;
  });
}
async function ownedMedia(m: Memorial, u: User) {
  return await many<Media>(
    canManage(m)
      ? "SELECT * FROM media WHERE memorial_id=? ORDER BY created_at"
      : "SELECT * FROM media WHERE memorial_id=? AND user_id=? AND hidden=0 ORDER BY created_at",
    ...(canManage(m) ? [m.id] : [m.id, u.id]),
  );
}
async function route(req: IncomingMessage, res: ServerResponse) {
  const origin = current().env.APP_ORIGIN || current().origin;
  const development = ["127.0.0.1", "localhost", "[::1]"].includes(
    new URL(origin).hostname,
  );
  const preview = false;
  const url = new URL(req.url || "/", origin),
    path = decodeURIComponent(url.pathname),
    method = req.method || "GET",
    user = await session(req),
    ip = String(req.headers["cf-connecting-ip"] || "local");
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
      return send(res, 200, { pending: await cleanupCount(u.id) });
  }
  if (path === "/api/session" && method === "GET")
    return send(res, 200, {
      user,
      emailConfigured: emailConfigured(),
      development,
      preview,
    });
  if (method === "POST" && path.startsWith("/api/park"))
    await rateLimit("park:" + ip, 300, 3600000);
  const park = await parkRoute(
    path,
    method,
    user,
    hash(ip + (req.headers["user-agent"] || "")),
    () => body(req),
    url.searchParams,
  );
  if (park) {
    return send(res, park.status, park.body);
  }
  if (path === "/api/memorials" && method === "GET") {
    const mine = url.searchParams.get("mine") === "1";
    if (mine) {
      const u = requireUser(user);
      const rows = await many<
        Memorial & {
          member_role: string;
          portrait_hidden: number | null;
          pending: number;
        }
      >(
        "SELECT DISTINCT m.*,md.hidden portrait_hidden,(SELECT COUNT(*) FROM memories e WHERE e.memorial_id=m.id AND e.status='pending') pending,a.role member_role FROM memorials m LEFT JOIN media md ON md.id=m.portrait_id LEFT JOIN members a ON a.memorial_id=m.id AND a.user_id=? AND a.status='accepted' WHERE m.owner_id=? OR (a.id IS NOT NULL AND (a.role='keeper' OR (m.status='published' AND m.moderated=0))) ORDER BY m.updated_at DESC",
        u.id,
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
            m.owner_id === u.id || m.member_role === "keeper" ? m.pending : 0,
        })),
      });
    }
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80),
      species = url.searchParams.get("species") || "",
      theme = url.searchParams.get("theme") || "";
    const rows = await many<
      Memorial & {
        portrait_hidden: number | null;
      }
    >(
      "SELECT m.*,md.hidden portrait_hidden FROM memorials m LEFT JOIN media md ON md.id=m.portrait_id WHERE m.status='published' AND m.visibility='public' AND m.moderated=0 AND instr(lower(m.name),lower(?))>0 AND (?='' OR m.species=?) AND (?='' OR m.theme=?) ORDER BY m.updated_at DESC LIMIT 200",
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
    await rateLimit("create:" + u.id, 30, 86400000);
    const b = validateMemorial(await body(req)),
      mid = id(),
      now = Date.now();
    let created = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const plot = await nextFreePlot();
      if (!plot) throw new HttpError(409, "No free plot is available nearby.");
      try {
        await batch([
          statement(
            "INSERT OR IGNORE INTO counters(name,value) VALUES('plot_index',0)",
          ),
          statement(
            "UPDATE counters SET value=value+1 WHERE name='plot_index'",
          ),
          statement(
            "INSERT INTO memorials(id,owner_id,name,species,born,passed,message,theme,setting,style,finish,visibility,review,arrangement,created_at,updated_at,plot_index,park_i,park_j,park_k) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT value-1 FROM counters WHERE name='plot_index'),?,?,?)",
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
            plot.i,
            plot.j,
            plot.k,
          ),
        ]);
        created = true;
        break;
      } catch (error) {
        if (!/UNIQUE constraint failed: memorials\.park_/.test(String(error)))
          throw error;
      }
    }
    if (!created)
      throw new HttpError(409, "That plot was just taken. Please try again.");
    return send(res, 201, await getMemorial(mid, u));
  }
  const match = path.match(/^\/api\/memorials\/([a-zA-Z0-9-]+)(?:\/(.*))?$/);
  if (match) {
    const [, mid, action = ""] = match;
    if (!action && method === "GET") {
      const m = await getMemorial(mid, user),
        memories = await memoriesFor(m, user),
        files = user ? await ownedMedia(m, user) : [];
      const contributors = [
        ...new Set(
          memories
            .filter(
              (v) => v.show_name && ["approved", "family"].includes(v.status),
            )
            .map((v) => v.author),
        ),
      ].map((name) => ({ name }));
      const candles = (
        await many<Candle>(
          "SELECT * FROM candles WHERE memorial_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 100",
          mid,
          Date.now(),
        )
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
            !(
              await one<{
                hidden: number;
              }>("SELECT hidden FROM media WHERE id=?", m.portrait_id)
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
      const m = await owner(mid, user),
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
      const updated = await run(
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
      return send(res, 200, await getMemorial(mid, user));
    }
    if (!action && method === "DELETE") {
      const m = await owner(mid, user),
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
      const files = await many<Media>(
        "SELECT * FROM media WHERE memorial_id=?",
        mid,
      );
      await batch([
        statement("DELETE FROM mail WHERE context_id=?", mid),
        ...queueFileCleanup(files, requireUser(user).id),
        statement("DELETE FROM memorials WHERE id=?", mid),
      ]);
      await retryFileCleanup(requireUser(user).id);
      return send(res, 200, {
        deleted: true,
        cleanupPending: (await cleanupCount(requireUser(user).id)) > 0,
      });
    }
    if (action === "media" && method === "POST") {
      const u = requireUser(user),
        m = await getMemorial(mid, u);
      canContribute(m, u);
      await rateLimit("upload:" + u.id, 100, 3600000);
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
        (await many("SELECT id FROM media WHERE memorial_id=?", mid)).length <
          250,
        "This memorial has reached its 250-photo limit.",
      );
      const content = req.headers["content-type"] || "";
      requireValue(
        ["image/jpeg", "image/png", "image/webp"].includes(content),
        "Choose a JPG, PNG or WebP photo.",
      );
      const bytes = await raw(req, 20000000);
      const env = current().env;
      if (!env.IMAGE_PROCESSOR_URL || !env.IMAGE_PROCESSOR_TOKEN)
        throw new HttpError(503, "Photo processing is not configured.");
      const endpoint = new URL("/normalize", env.IMAGE_PROCESSOR_URL);
      for (const key of ["purpose", "zoom", "x", "y"]) {
        const value = url.searchParams.get(key);
        if (value !== null) endpoint.searchParams.set(key, value);
      }
      const processed = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.IMAGE_PROCESSOR_TOKEN,
          "Content-Type": content,
        },
        body: new Uint8Array(bytes).buffer,
        signal: AbortSignal.timeout(60000),
      });
      if (!processed.ok || !processed.body)
        throw new HttpError(
          processed.status >= 500 ? 503 : 400,
          "This photo could not be processed. Choose a JPG, PNG or WebP under 20 MB and 40 megapixels.",
        );
      const format = processed.headers.get("X-Source-Format");
      if (
        !format ||
        !["image/jpeg", "image/png", "image/webp"].includes(format)
      )
        throw new HttpError(
          502,
          "Photo processing returned an invalid format.",
        );
      const fid = id(),
        file = fid + ".jpg",
        original =
          fid +
          ".original." +
          (format === "image/jpeg" ? "jpg" : format.slice(6));
      const filename = text(
        url.searchParams.get("filename") || "Photograph",
        "File name",
        150,
        true,
      );
      // Durable reservations also cover a Worker termination between R2 and D1 writes.
      await batch(
        [file, original].map((key) =>
          statement(
            "INSERT INTO file_cleanup(path,requested_by,created_at,lease_token,lease_until) VALUES(?,?,?,?,?)",
            key,
            u.id,
            Date.now(),
            "upload:" + fid,
            Date.now() + 10 * 60000,
          ),
        ),
      );
      try {
        await env.BUCKET.put(original, bytes, {
          httpMetadata: { contentType: format },
        });
        const displayBytes = await raw(processed.body, 20_000_000);
        const normalized = await env.BUCKET.put(file, displayBytes, {
          httpMetadata: { contentType: "image/jpeg" },
        });
        if (!normalized) throw Error("Photo storage failed.");
        const writes = [
          statement(
            "INSERT INTO media(id,memorial_id,user_id,purpose,filename,path,original_path,bytes,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM media WHERE memorial_id=?)<250",
            fid,
            mid,
            u.id,
            purpose,
            filename,
            file,
            original,
            normalized.size,
            Date.now(),
            mid,
          ),
          statement(
            "DELETE FROM file_cleanup WHERE path IN (?,?) AND EXISTS(SELECT 1 FROM media WHERE id=?)",
            file,
            original,
            fid,
          ),
        ];
        if (purpose === "portrait")
          writes.push(
            statement(
              "UPDATE memorials SET portrait_id=?,version=version+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM media WHERE id=?)",
              fid,
              Date.now(),
              mid,
              fid,
            ),
          );
        const saved = await batch(writes);
        if (!saved[0].meta.changes)
          throw new HttpError(
            409,
            "This memorial already has 250 photographs.",
          );
      } catch (error) {
        await run(
          "UPDATE file_cleanup SET lease_token=NULL,lease_until=0 WHERE path IN (?,?) AND lease_token=?",
          file,
          original,
          "upload:" + fid,
        );
        await retryFileCleanup(u.id);
        throw error;
      }
      return send(res, 201, { id: fid, url: "/media/" + fid, purpose });
    }
    if (action.startsWith("media/") && method === "DELETE") {
      const u = requireUser(user),
        m = await getMemorial(mid, u),
        file = await one<Media>(
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
        !(
          await many<{
            media_ids: string;
          }>("SELECT media_ids FROM memories WHERE memorial_id=?", mid)
        ).some((v) => (JSON.parse(v.media_ids) as string[]).includes(file.id)),
        "Remove this photo from its memory before deleting it.",
      );
      await batch([
        statement(
          "UPDATE memorials SET portrait_id=NULL,version=version+1 WHERE portrait_id=?",
          file.id,
        ),
        ...queueFileCleanup([file], u.id),
        statement("DELETE FROM media WHERE id=?", file.id),
      ]);
      await retryFileCleanup(u.id);
      return send(res, 200, {
        deleted: true,
        cleanupPending: (await cleanupCount(u.id)) > 0,
      });
    }
    if (action === "portrait" && method === "POST") {
      const m = await owner(mid, user),
        b = await body(req),
        file = await one<Media>(
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
      await run(
        "UPDATE memorials SET portrait_id=?,version=version+1 WHERE id=?",
        file.id,
        mid,
      );
      return send(res, 200, await getMemorial(mid, user));
    }
    if (action === "memories" && method === "POST") {
      const u = requireUser(user),
        m = await getMemorial(mid, u);
      canContribute(m, u);
      await rateLimit("memory:" + u.id, 50, 3600000);
      const b = await body(req),
        mediaIds = await memoryMedia(b.media_ids || [], m, u),
        memoryId = id(),
        now = Date.now();
      const status = canManage(m) || !m.review ? "approved" : "pending";
      await run(
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
        m = await getMemorial(mid, u),
        memory = await one<Memory>(
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
        await run("DELETE FROM memories WHERE id=?", memory.id);
        return send(res, 200, { deleted: true });
      }
      if (method === "PATCH") {
        const b = await body(req);
        if (b.decision) {
          await owner(mid, u);
          const decision = choice(
            b.decision,
            ["approved", "family", "declined"],
            "review decision",
          );
          requireValue(
            memory.status !== "hidden",
            "This memory is hidden by moderation.",
          );
          const reviewed = await run(
            "UPDATE memories SET status=?,updated_at=? WHERE id=? AND status=?",
            decision,
            Date.now(),
            memory.id,
            memory.status,
          );
          if (!reviewed.changes)
            throw new HttpError(
              409,
              "This memory changed. Reload before reviewing it.",
            );
          const author = (await one<User>(
            "SELECT * FROM users WHERE id=?",
            memory.user_id,
          ))!;
          await queueEmail(
            author.email,
            `Your memory of ${m.name}`,
            `Your memory “${memory.title}” was ${decision}.\n${origin}/#/m/${mid}`,
            mid,
          );
          current().ctx.waitUntil(deliverMail());
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
        const hidden = new Set(
          (
            await many<{
              id: string;
            }>("SELECT id FROM media WHERE memorial_id=? AND hidden=1", mid)
          ).map((v) => v.id),
        );
        const hiddenIds = (
          JSON.parse(memory.media_ids as unknown as string) as string[]
        ).filter((fid) => hidden.has(fid));
        const mediaIds = [
          ...new Set([
            ...(await memoryMedia(b.media_ids || [], m, u)),
            ...hiddenIds,
          ]),
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
        const edited = await run(
          "UPDATE memories SET title=?,story=?,date=?,media_ids=?,status=?,show_name=?,updated_at=? WHERE id=? AND status=?",
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
          memory.status,
        );
        if (!edited.changes)
          throw new HttpError(
            409,
            "This memory changed. Reload before editing it.",
          );
        return send(res, 200, { status });
      }
    }
    if (action === "candles" && method === "POST") {
      const u = requireUser(user),
        m = await getMemorial(mid, u);
      canContribute(m, u);
      const b = await body(req);
      requireValue(
        typeof b.anonymous === "boolean",
        "Choose whether to show your name.",
      );
      const existing = await one<Candle>(
        "SELECT * FROM candles WHERE memorial_id=? AND user_id=?",
        mid,
        u.id,
      );
      if (existing && existing.expires_at > Date.now())
        return send(res, 200, { id: existing.id, alreadyLit: true });
      const now = Date.now(),
        cid = id();
      const lit = await one<{ id: string }>(
        "INSERT INTO candles(id,memorial_id,user_id,author,anonymous,message,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(memorial_id,user_id) DO UPDATE SET id=excluded.id,author=excluded.author,anonymous=excluded.anonymous,message=excluded.message,created_at=excluded.created_at,expires_at=excluded.expires_at WHERE candles.expires_at<=? RETURNING id",
        cid,
        mid,
        u.id,
        u.name,
        Number(b.anonymous),
        text(b.message || "", "Tribute", 500),
        now,
        now + 7 * 86400000,
        now,
      );
      if (!lit) {
        const active = await one<Candle>(
          "SELECT * FROM candles WHERE memorial_id=? AND user_id=?",
          mid,
          u.id,
        );
        return send(res, 200, { id: active?.id, alreadyLit: true });
      }
      return send(res, 201, { id: cid });
    }
    if (action.startsWith("candles/") && method === "DELETE") {
      const u = requireUser(user),
        m = await getMemorial(mid, u),
        c = await one<Candle>(
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
      await run("DELETE FROM candles WHERE id=?", c.id);
      return send(res, 200, { deleted: true });
    }
    if (action === "members" && method === "GET") {
      await owner(mid, user);
      return send(res, 200, {
        items: await many<Member>(
          "SELECT m.*,i.expires_at FROM members m LEFT JOIN invitations i ON i.member_id=m.id WHERE m.memorial_id=? ORDER BY m.created_at",
          mid,
        ),
      });
    }
    if (action === "members" && method === "POST") {
      const u = requireUser(user),
        m = await owner(mid, u),
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
            (await one<User>("SELECT * FROM users WHERE id=?", m.owner_id))
              ?.email,
        "This person already manages this memorial.",
      );
      await rateLimit("invite:" + u.id, 30, 3600000);
      const value = token(),
        memberId = id();
      const old = await one<Member>(
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
      const writes: D1PreparedStatement[] = [];
      if (old)
        writes.push(
          statement(
            "DELETE FROM members WHERE id=? AND status=? AND role=?",
            old.id,
            old.status,
            old.role,
          ),
        );
      writes.push(
        statement(
          "INSERT INTO members(id,memorial_id,email,role,status,created_at) VALUES(?,?,?,?,?,?)",
          memberId,
          mid,
          address,
          role,
          "invited",
          Date.now(),
        ),
        statement(
          "INSERT INTO invitations(hash,member_id,expires_at) VALUES(?,?,?)",
          hash(value),
          memberId,
          Date.now() + 7 * 86400000,
        ),
      );
      try {
        await batch(writes);
      } catch (error) {
        if (/UNIQUE constraint/.test(String(error)))
          throw new HttpError(
            409,
            "This invitation changed. Reload before trying again.",
          );
        throw error;
      }
      const inviteUrl = origin + "/#/invite/" + value;
      await queueEmail(
        address,
        `An invitation to remember ${m.name}`,
        `${u.name} invited you to ${m.name}’s memorial as a ${role}. Sign in with ChatGPT using this email and accept within seven days:\n${inviteUrl}`,
        mid,
      );
      current().ctx.waitUntil(deliverMail());
      return send(res, 201, {
        id: memberId,
        inviteUrl,
      });
    }
    if (action.startsWith("members/") && method === "PATCH") {
      const m = await owner(mid, user),
        member = await one<Member>(
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
      await run("UPDATE members SET role=? WHERE id=?", role, member.id);
      return send(res, 200, { role });
    }
    if (action.startsWith("members/") && method === "DELETE") {
      const m = await owner(mid, user),
        member = await one<Member>(
          "SELECT * FROM members WHERE id=? AND memorial_id=?",
          action.slice(8),
          mid,
        );
      if (member?.role === "keeper" && m.role !== "owner")
        throw new HttpError(
          403,
          "Only the original owner can revoke a co-keeper.",
        );
      await run(
        "DELETE FROM members WHERE id=? AND memorial_id=?",
        action.slice(8),
        mid,
      );
      return send(res, 200, { revoked: true });
    }
    if (action === "export" && method === "GET") {
      const m = await owner(mid, user),
        files = await many<Media>(
          "SELECT * FROM media WHERE memorial_id=?",
          mid,
        ),
        memories = await memoriesFor(m, user);
      const archive = await memorialExport(m, files, memories);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="everleaf-memorial.zip"',
        "Cache-Control": "no-store",
      });
      await pipeline(archive, res);
      return;
    }
  }
  if (path.startsWith("/api/invitations/")) {
    const u = requireUser(user),
      value = path.slice(17),
      invite = await one<{
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
    const m = (await one<Memorial>(
      "SELECT * FROM memorials WHERE id=?",
      invite.memorial_id,
    ))!;
    if (method === "GET")
      return send(res, 200, {
        name: m.name,
        role: invite.role,
        memorial_id: m.id,
      });
    if (method === "POST") {
      const result = await batch([
        statement(
          "UPDATE members SET status='accepted',name=?,user_id=? WHERE id=? AND status='invited' AND NOT EXISTS(SELECT 1 FROM members existing WHERE existing.memorial_id=members.memorial_id AND existing.user_id=?) AND EXISTS(SELECT 1 FROM invitations WHERE member_id=? AND hash=? AND expires_at>?)",
          u.name,
          u.id,
          invite.id,
          u.id,
          invite.id,
          hash(value),
          Date.now(),
        ),
        statement("DELETE FROM invitations WHERE hash=?", hash(value)),
      ]);
      if (!result[0].meta.changes)
        throw new HttpError(
          409,
          "This invitation expired or was already used.",
        );
      return send(res, 200, { memorial_id: m.id });
    }
  }
  if (path === "/api/reports" && method === "POST") {
    const u = requireUser(user),
      b = await body(req),
      m = await getMemorial(String(b.memorial_id), u);
    requireValue(m.status === "published", "Report a published memorial.");
    await rateLimit("report:" + u.id, 20, 3600000);
    const memoryId = b.memory_id ? String(b.memory_id) : null;
    if (memoryId)
      requireValue(
        (await memoriesFor(m, u)).some(
          (v) => v.id === memoryId && ["approved", "family"].includes(v.status),
        ),
        "Choose a visible memory to report.",
      );
    const rid = id();
    await run(
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
    const reports = await many<
      Report & {
        media_ids: string | null;
        portrait_id: string | null;
      }
    >(
      "SELECT r.*,m.name memorial_name,m.portrait_id,e.title memory_title,e.story memory_story,e.media_ids FROM reports r LEFT JOIN memorials m ON m.id=r.memorial_id LEFT JOIN memories e ON e.id=r.memory_id ORDER BY r.created_at DESC LIMIT 200",
    );
    const allIds = [
      ...new Set(
        reports.flatMap((r) =>
          r.memory_id
            ? (JSON.parse(r.media_ids || "[]") as string[])
            : r.portrait_id
              ? [r.portrait_id]
              : [],
        ),
      ),
    ];
    const files = allIds.length
      ? await many<Media>(
          "SELECT id,filename,hidden FROM media WHERE id IN (SELECT value FROM json_each(?))",
          JSON.stringify(allIds),
        )
      : [];
    return send(res, 200, {
      items: reports.map((r) => ({
        ...r,
        media: (r.memory_id
          ? (JSON.parse(r.media_ids || "[]") as string[])
          : r.portrait_id
            ? [r.portrait_id]
            : []
        )
          .map((fid) => files.find((f) => f.id === fid))
          .filter(Boolean),
      })),
    });
  }
  if (path.match(/^\/api\/reports\/[a-zA-Z0-9-]+$/) && method === "PATCH") {
    const u = moderation(user),
      rid = path.split("/").at(-1)!,
      report = await one<Report>("SELECT * FROM reports WHERE id=?", rid);
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
      ? await one<
          Memory & {
            previous_status: string | null;
          }
        >("SELECT * FROM memories WHERE id=?", report.memory_id)
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
      const file = await one<Media>(
        "SELECT * FROM media WHERE id=? AND memorial_id=?",
        b.media_id,
        report.memorial_id!,
      );
      const belongs = targetMemory
        ? (
            JSON.parse(targetMemory.media_ids as unknown as string) as string[]
          ).includes(b.media_id)
        : (
            await one<Memorial>(
              "SELECT * FROM memorials WHERE id=?",
              report.memorial_id!,
            )
          )?.portrait_id === b.media_id;
      requireValue(
        file && file.purpose !== "reference" && belongs,
        "Choose a photograph attached to this reported item.",
      );
      photoId = file.id;
    }
    const guard =
      "EXISTS(SELECT 1 FROM reports WHERE id=? AND status=? AND decision=?)";
    const guardArgs = [rid, report.status, report.decision];
    const writes: D1PreparedStatement[] = [];
    if (action === "hide_photo" || action === "restore_photo")
      writes.push(
        statement(
          "UPDATE media SET hidden=? WHERE id=? AND " + guard,
          action === "hide_photo" ? 1 : 0,
          photoId!,
          ...guardArgs,
        ),
      );
    if (action === "restore_memory")
      writes.push(
        statement(
          "UPDATE memories SET status=?,previous_status=NULL,updated_at=? WHERE id=? AND status='hidden' AND " +
            guard,
          targetMemory!.previous_status || "approved",
          Date.now(),
          report.memory_id!,
          ...guardArgs,
        ),
      );
    if (action === "hide_memory")
      writes.push(
        statement(
          "UPDATE memories SET previous_status=CASE WHEN status='hidden' THEN previous_status ELSE status END,status='hidden',updated_at=? WHERE id=? AND " +
            guard,
          Date.now(),
          report.memory_id!,
          ...guardArgs,
        ),
      );
    if (action === "remove_memory")
      writes.push(
        statement(
          "DELETE FROM memories WHERE id=? AND " + guard,
          report.memory_id!,
          ...guardArgs,
        ),
      );
    if (action === "hide_memorial" || action === "restore_memorial")
      writes.push(
        statement(
          "UPDATE memorials SET moderated=?,version=version+1 WHERE id=? AND " +
            guard,
          action === "hide_memorial" ? 1 : 0,
          report.memorial_id!,
          ...guardArgs,
        ),
      );
    // Guard every target with the reviewed report state before committing the audit and decision.
    const audit = statement(
      "INSERT INTO audit(id,user_id,report_id,action,reason,target_id,created_at) SELECT ?,?,?,?,?,?,? WHERE " +
        (writes.length ? "changes()=1 AND " : "") +
        guard,
      id(),
      u.id,
      rid,
      action,
      reason,
      photoId || report.memory_id || report.memorial_id,
      Date.now(),
      ...guardArgs,
    );
    writes.push(
      audit,
      statement(
        "UPDATE reports SET status=?,decision=? WHERE id=? AND status=? AND decision=? AND changes()=1",
        action === "dismiss" ? "dismissed" : "actioned",
        action + ": " + reason,
        ...guardArgs,
      ),
    );
    const result = await batch(writes);
    if (!result.at(-1)!.meta.changes)
      throw new HttpError(
        409,
        "This report changed. Reload before reviewing again.",
      );
    if (report.memorial_id) {
      const recipient = await one<{
        email: string;
      }>(
        "SELECT u.email FROM users u JOIN memorials m ON m.owner_id=u.id WHERE m.id=?",
        report.memorial_id,
      );
      if (recipient)
        await queueEmail(
          recipient.email,
          "An update about your Everleaf memorial",
          `Moderation decision: ${action.replaceAll("_", " ")}\nReason: ${reason}`,
          report.memorial_id,
        );
      const reporter = await one<User>(
        "SELECT * FROM users WHERE id=?",
        report.reporter_id,
      );
      if (reporter)
        await queueEmail(
          reporter.email,
          "Your Everleaf report was reviewed",
          "Your report was reviewed and a decision was recorded.",
          report.memorial_id,
        );
      current().ctx.waitUntil(deliverMail());
    }
    return send(res, 200, { action, reason });
  }
  if (path.startsWith("/media/") && method === "GET") {
    const file = await one<Media>(
      "SELECT * FROM media WHERE id=?",
      path.slice(7),
    );
    if (!file) throw new HttpError(404, "Photo not found.");
    await allowedMedia(file, user);
    const object = await current().env.BUCKET.get(file.path);
    if (!object) throw new HttpError(404, "Photo not found.");
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": object.size,
      "Cache-Control": "private, no-store",
    });
    await pipeline(object.body, res);
    return;
  }
  throw new HttpError(404, "Not found.");
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
    if (String(error).includes("EVERLEAF_MEDIA_CHANGED"))
      error = new HttpError(
        409,
        "A photo or its memorial changed. Reload before trying again.",
      );
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
server.listen(4880);
export default httpServerHandler({ port: 4880 });
