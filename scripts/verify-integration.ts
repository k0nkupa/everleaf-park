import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rm,
  rename,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import type { Memorial, Media, Memory } from "../src/types.ts";
const scratch = await mkdtemp(resolve(tmpdir(), "everleaf-integration-"));
const port = await new Promise<number>((done) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address === "object");
    server.close(() => done(address.port));
  });
});
const origin = `http://127.0.0.1:${port}`;
let child: ReturnType<typeof spawn> | null = null,
  logs = "",
  checks: string[] = [];
async function start() {
  await new Promise<void>((done, reject) => {
    child = spawn(
      process.execPath,
      ["--experimental-strip-types", "src/server.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          HOST: "127.0.0.1",
          APP_ORIGIN: origin,
          DATA_DIR: scratch,
          NODE_ENV: "development",
          RESEND_API_KEY: "",
          EMAIL_FROM: "",
          MODERATOR_EMAILS: "moderator@example.test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const timeout = setTimeout(
      () => reject(Error("Server did not start: " + logs)),
      15000,
    );
    child.stdout!.on("data", (chunk) => {
      logs += chunk;
      if (logs.includes("Everleaf:")) {
        clearTimeout(timeout);
        done();
      }
    });
    child.stderr!.on("data", (chunk) => (logs += chunk));
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code) reject(Error("Server failed: " + logs));
    });
  });
}
async function stop() {
  const proc = child;
  if (!proc) return;
  await new Promise<void>((done) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      done();
    }, 6000);
    proc.once("exit", () => {
      clearTimeout(timeout);
      done();
    });
    proc.kill("SIGTERM");
  });
  child = null;
  logs = "";
}
function client() {
  return {
    cookie: "",
    async request(
      path: string,
      method = "GET",
      data?: unknown,
      expected = 200,
    ) {
      const r = await fetch(origin + path, {
        method,
        headers: {
          Origin: origin,
          ...(this.cookie ? { Cookie: this.cookie } : {}),
          ...(data ? { "Content-Type": "application/json" } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
        redirect: "manual",
      });
      const body = await r.json();
      assert.equal(
        r.status,
        expected,
        `${method} ${path}: ${JSON.stringify(body)}`,
      );
      return body;
    },
    async login(email: string, name: string) {
      const reply = await this.request(
        "/api/auth/request",
        "POST",
        { email, name },
        202,
      );
      assert(reply.loginUrl, "Local authentication must not send email");
      const link = new URL(reply.loginUrl);
      const confirm = await fetch(reply.loginUrl);
      assert.equal(confirm.status, 200);
      assert((await confirm.text()).includes("confirm-login"));
      const r = await fetch(origin + "/auth/verify", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: link.searchParams.get("token")! }),
        redirect: "manual",
      });
      assert.equal(r.status, 303);
      this.cookie = r.headers.getSetCookie()[0].split(";")[0];
      assert(this.cookie.startsWith("everleaf="));
      const session = await this.request("/api/session");
      assert.equal(session.user.email, email);
      const consumed = await fetch(reply.loginUrl, { redirect: "manual" });
      assert.equal(consumed.status, 303);
      checks.push("single-use sign-in: " + name);
    },
  };
}
const owner = client(),
  alex = client(),
  viewer = client(),
  stranger = client(),
  moderator = client(),
  anon = client();
const base = {
  name: "Biscuit",
  species: "dog",
  born: "Spring 2011",
  passed: "Autumn 2025",
  message: "Every muddy walk, kept close.",
  theme: "A",
  setting: "house",
  style: "stylized",
  finish: "glaze",
  visibility: "private",
  review: true,
  arrangement: [],
};
let m: Memorial;
async function patch(over: Record<string, unknown> = {}) {
  m = await owner.request("/api/memorials/" + m.id, "PATCH", { ...m, ...over });
  return m;
}
async function upload(
  who: ReturnType<typeof client>,
  purpose: string,
  source = "A0.jpg",
  expected = 201,
) {
  const image = await readFile(resolve("public/assets/img", source));
  const r = await fetch(
    origin +
      `/api/memorials/${m.id}/media?purpose=${purpose}&filename=${source}`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: who.cookie,
        "Content-Type": "image/jpeg",
      },
      body: image,
    },
  );
  const b = await r.json();
  assert.equal(r.status, expected, JSON.stringify(b));
  return b as { id: string; url: string };
}
try {
  await start();
  await anon.request("/api/preview/session", "POST", {}, 404);
  checks.push(
    "email-free session route is unavailable outside explicit preview mode",
  );
  await owner.login("owner@example.test", "Owner");
  await alex.login("alex@example.test", "Alex");
  await viewer.login("viewer@example.test", "Viewer");
  await stranger.login("stranger@example.test", "Stranger");
  await moderator.login("moderator@example.test", "Moderator");
  assert.equal((await anon.request("/api/memorials")).items.length, 0);
  await anon.request("/api/memorials", "POST", base, 401);
  const csrf = await fetch(origin + "/api/memorials", {
    method: "POST",
    headers: {
      Cookie: owner.cookie,
      Origin: "https://elsewhere.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(base),
  });
  assert.equal(csrf.status, 403);
  await csrf.text();
  checks.push("CSRF and sign-in required for writes");
  await owner.request(
    "/api/memorials",
    "POST",
    { ...base, passed: "2009" },
    400,
  );
  await owner.request(
    "/api/memorials",
    "POST",
    { ...base, born: "2011-12-30", passed: "2011-01-01" },
    400,
  );
  await owner.request(
    "/api/memorials",
    "POST",
    { ...base, born: "2011-02-30" },
    400,
  );
  checks.push("full calendar date ordering and impossible dates rejected");
  m = await owner.request("/api/memorials", "POST", base, 201);
  assert.equal(m.version, 1);
  await anon.request("/api/memorials/" + m.id, "GET", undefined, 404);
  await stranger.request("/api/memorials/" + m.id, "GET", undefined, 404);
  checks.push("private draft and invalid date boundaries");
  const file = await upload(owner, "portrait");
  assert.deepEqual(
    await readFile(resolve(scratch, "media", file.id + ".original.jpg")),
    await readFile(resolve("public/assets/img/A0.jpg")),
  );
  checks.push("original uploaded photo preserved byte-for-byte");
  m = await owner.request("/api/memorials/" + m.id);
  assert.equal(m.portrait_id, file.id);
  const privatePhoto = await fetch(origin + file.url);
  assert.equal(privatePhoto.status, 404);
  await privatePhoto.text();
  await owner.request(
    "/api/memorials/" + m.id,
    "PATCH",
    { ...m, version: 1 },
    409,
  );
  checks.push("portrait persisted privately and stale writes rejected");
  const bad = await fetch(
    origin + `/api/memorials/${m.id}/media?purpose=album`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: owner.cookie,
        "Content-Type": "image/jpeg",
      },
      body: "not a photograph",
    },
  );
  assert.equal(bad.status, 400);
  await bad.text();
  checks.push("corrupt upload rejected");
  const ref = await upload(owner, "reference");
  const albumOwner = await upload(owner, "album");
  m = await owner.request("/api/memorials/" + m.id);
  for (const theme of ["A", "B", "C"])
    for (const setting of ["house", "garden"])
      for (const style of ["stylized", "photo"]) {
        await patch({ theme, setting, style });
        const saved = await owner.request("/api/memorials/" + m.id);
        assert.equal(saved.theme, theme);
        assert.equal(saved.setting, setting);
        assert.equal(saved.style, style);
      }
  checks.push(
    "all 12 theme/setting/sculpture combinations saved and read back",
  );
  await patch({
    status: "published",
    visibility: "public",
    arrangement: [
      { kind: "Memory album", x: 44, y: 65 },
      { kind: "Flowers", x: 70, y: 55 },
    ],
  });
  assert.equal((await anon.request("/api/memorials?q=bisc")).items[0].id, m.id);
  assert.equal(
    (await anon.request("/api/memorials?species=cat")).items.length,
    0,
  );
  const photo = await fetch(origin + file.url);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/jpeg");
  await photo.arrayBuffer();
  assert.equal((await fetch(origin + ref.url)).status, 404);
  checks.push(
    "public discovery/filtering, portrait access and private references",
  );
  await patch({ visibility: "link" });
  assert.equal((await anon.request("/api/memorials")).items.length, 0);
  await anon.request("/api/memorials/" + m.id);
  await patch({ visibility: "private" });
  await anon.request("/api/memorials/" + m.id, "GET", undefined, 404);
  checks.push("link-only and private visibility differ");
  const vi = await owner.request(
    `/api/memorials/${m.id}/members`,
    "POST",
    { email: "viewer@example.test", role: "viewer" },
    201,
  );
  const vt = new URL(vi.inviteUrl).hash.split("/").at(-1)!;
  await stranger.request("/api/invitations/" + vt, "POST", {}, 403);
  await viewer.request("/api/invitations/" + vt, "POST", {});
  await viewer.request("/api/memorials/" + m.id);
  await viewer.request(
    `/api/memorials/${m.id}/memories`,
    "POST",
    { title: "No permission", story: "Denied", media_ids: [] },
    403,
  );
  checks.push("invitation bound to recipient; viewer cannot contribute");
  const ai = await owner.request(
    `/api/memorials/${m.id}/members`,
    "POST",
    { email: "alex@example.test", role: "contributor" },
    201,
  );
  const at = new URL(ai.inviteUrl).hash.split("/").at(-1)!;
  await alex.request("/api/invitations/" + at, "POST", {});
  const attached = await upload(alex, "album");
  const ownView = await alex.request("/api/memorials/" + m.id);
  assert(ownView.media.some((f: Media) => f.id === attached.id));
  const memory = await alex.request(
    `/api/memorials/${m.id}/memories`,
    "POST",
    {
      title: "Beach mornings",
      story: "The waves and the sunny way home.",
      date: "Summer 2019",
      media_ids: [attached.id],
    },
    201,
  );
  assert.equal(memory.status, "pending");
  await patch({ visibility: "public" });
  const publicBefore = await anon.request("/api/memorials/" + m.id);
  assert(!publicBefore.memories.some((v: Memory) => v.id === memory.id));
  assert.equal((await fetch(origin + attached.url)).status, 404);
  await stranger.request(
    `/api/memorials/${m.id}/memories/${memory.id}`,
    "PATCH",
    { decision: "approved" },
    403,
  );
  await owner.request(`/api/memorials/${m.id}/memories/${memory.id}`, "PATCH", {
    decision: "approved",
  });
  const publicAfter = await anon.request("/api/memorials/" + m.id);
  assert(publicAfter.memories.some((v: Memory) => v.id === memory.id));
  assert.equal(
    publicAfter.memories.find((v: Memory) => v.id === memory.id).author,
    "Anonymous",
  );
  assert(
    !publicAfter.contributors.some((v: { name: string }) => v.name === "Alex"),
  );
  await alex.request(`/api/memorials/${m.id}/memories/${memory.id}`, "PATCH", {
    title: "Beach mornings",
    story: "The waves and the sunny way home.",
    date: "Summer 2019",
    media_ids: [attached.id],
    show_name: true,
  });
  await owner.request(`/api/memorials/${m.id}/memories/${memory.id}`, "PATCH", {
    decision: "approved",
  });
  assert(
    (await anon.request("/api/memorials/" + m.id)).contributors.some(
      (v: { name: string }) => v.name === "Alex",
    ),
  );
  await owner.request(`/api/memorials/${m.id}/memories/${memory.id}`, "PATCH", {
    decision: "family",
  });
  assert(
    !(await anon.request("/api/memorials/" + m.id)).memories.some(
      (v: Memory) => v.id === memory.id,
    ),
  );
  assert.equal((await fetch(origin + attached.url)).status, 404);
  assert(
    (await viewer.request("/api/memorials/" + m.id)).memories.some(
      (v: Memory) => v.id === memory.id,
    ),
  );
  await owner.request(`/api/memorials/${m.id}/memories/${memory.id}`, "PATCH", {
    decision: "approved",
  });
  checks.push(
    "names require consent; family-only memories and photos stay out of public visits",
  );
  assert.equal((await fetch(origin + attached.url)).status, 200);
  checks.push("real contribution upload, pending privacy and owner approval");
  await alex.request(
    `/api/memorials/${m.id}/candles`,
    "POST",
    { anonymous: true, message: "For our friend." },
    201,
  );
  const duplicate = await alex.request(
    `/api/memorials/${m.id}/candles`,
    "POST",
    { anonymous: false, message: "Duplicate." },
  );
  assert.equal(duplicate.alreadyLit, true);
  const visit = await stranger.request("/api/memorials/" + m.id);
  assert.equal(visit.candles[0].author, "Anonymous");
  assert.equal(visit.candles[0].user_id, "");
  checks.push(
    "persistent candle, duplicate prevention and anonymous attribution",
  );
  await stranger.request(
    "/api/reports",
    "POST",
    {
      memorial_id: m.id,
      memory_id: memory.id,
      reason: "privacy",
      detail: "Please review this photograph.",
    },
    201,
  );
  await owner.request("/api/reports", "GET", undefined, 403);
  const reports = await moderator.request("/api/reports");
  const report = reports.items[0];
  await moderator.request(
    "/api/reports/" + report.id,
    "PATCH",
    { action: "hide_photo", media_id: ref.id, reason: "Invalid scope" },
    400,
  );
  await moderator.request("/api/reports/" + report.id, "PATCH", {
    action: "hide_photo",
    media_id: attached.id,
    reason: "Photo privacy",
  });
  const photoHidden = await anon.request("/api/memorials/" + m.id);
  assert(
    photoHidden.memories.some(
      (v: Memory) => v.id === memory.id && v.media_ids.length === 0,
    ),
  );
  assert.equal((await fetch(origin + attached.url)).status, 404);
  await alex.request(`/api/memorials/${m.id}/memories/${memory.id}`, "PATCH", {
    title: "Beach mornings",
    story: "An edited story, keeping its hidden photo.",
    media_ids: [],
    show_name: true,
  });
  const edited = await owner.request("/api/memorials/" + m.id);
  assert(
    edited.memories
      .find((v: Memory) => v.id === memory.id)
      .media_ids.includes(attached.id),
  );
  await moderator.request("/api/reports/" + report.id, "PATCH", {
    action: "restore_photo",
    media_id: attached.id,
    reason: "Photo reviewed",
  });
  await owner.request(`/api/memorials/${m.id}/memories/${memory.id}`, "PATCH", {
    decision: "approved",
  });
  assert.equal((await fetch(origin + attached.url)).status, 200);
  checks.push(
    "story edits preserve hidden photo attachment for later moderation reversal",
  );
  checks.push(
    "photo-only moderation is scoped, reversible and preserves the written memory",
  );
  await moderator.request("/api/reports/" + report.id, "PATCH", {
    action: "hide_memory",
    reason: "Privacy review.",
  });
  assert(
    !(await anon.request("/api/memorials/" + m.id)).memories.some(
      (v: Memory) => v.id === memory.id,
    ),
  );
  await owner.request(
    `/api/memorials/${m.id}/memories/${memory.id}`,
    "PATCH",
    { decision: "approved" },
    400,
  );
  checks.push(
    "moderator isolation, recorded hide action and no owner unhide bypass",
  );
  await moderator.request("/api/reports/" + report.id, "PATCH", {
    action: "restore_memory",
    reason: "Memory reviewed",
  });
  assert(
    (await anon.request("/api/memorials/" + m.id)).memories.some(
      (v: Memory) => v.id === memory.id,
    ),
  );
  await owner.request(`/api/memorials/${m.id}/memories/${memory.id}`, "PATCH", {
    decision: "family",
  });
  await moderator.request("/api/reports/" + report.id, "PATCH", {
    action: "hide_memory",
    reason: "Family review",
  });
  await moderator.request("/api/reports/" + report.id, "PATCH", {
    action: "restore_memory",
    reason: "Family review complete",
  });
  assert(
    !(await anon.request("/api/memorials/" + m.id)).memories.some(
      (v: Memory) => v.id === memory.id,
    ),
  );
  checks.push("restoring a moderated memory preserves family-only privacy");
  await moderator.request("/api/reports/" + report.id, "PATCH", {
    action: "hide_memorial",
    reason: "Memorial review.",
  });
  await anon.request("/api/memorials/" + m.id, "GET", undefined, 404);
  m = await owner.request("/api/memorials/" + m.id);
  await owner.request(
    "/api/memorials/" + m.id,
    "PATCH",
    { ...m, status: "published" },
    400,
  );
  await moderator.request("/api/reports/" + report.id, "PATCH", {
    action: "restore_memorial",
    reason: "Review complete.",
  });
  m = await owner.request("/api/memorials/" + m.id);
  checks.push("moderated memorial hidden and cannot republish around review");
  const archive = await fetch(origin + `/api/memorials/${m.id}/export`, {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(archive.status, 200);
  assert(archive.headers.get("content-type")?.includes("zip"));
  const bytes = Buffer.from(await archive.arrayBuffer());
  assert(bytes.includes(Buffer.from("memorial.json")));
  assert(bytes.includes(Buffer.from(file.id + ".jpg")));
  assert(bytes.includes(Buffer.from("originals/" + file.id + ".jpg")));
  await writeFile(resolve(scratch, "export.zip"), bytes);
  await stranger.request(
    `/api/memorials/${m.id}/export`,
    "GET",
    undefined,
    403,
  );
  checks.push("owner ZIP export includes actual photos; other users denied");
  const beforeId = m.id,
    version = m.version;
  await stop();
  await start();
  m = await owner.request("/api/memorials/" + beforeId);
  assert.equal(m.version, version);
  assert.equal(m.arrangement.length, 2);
  assert.equal(m.candles?.length, 1);
  checks.push(
    "database, session, arrangement and candle survive a server restart",
  );
  await patch({ visibility: "private" });
  await owner.request(`/api/memorials/${m.id}/members/${ai.id}`, "DELETE");
  await alex.request("/api/memorials/" + m.id, "GET", undefined, 404);
  const outstanding = await owner.request(
    `/api/memorials/${m.id}/members`,
    "POST",
    { email: "stranger@example.test", role: "contributor" },
    201,
  );
  const ot = new URL(outstanding.inviteUrl).hash.split("/").at(-1)!;
  await owner.request(
    `/api/memorials/${m.id}/members/${outstanding.id}`,
    "DELETE",
  );
  await stranger.request("/api/invitations/" + ot, "POST", {}, 404);
  checks.push(
    "revocation removes private access and invalidates pending invitations",
  );
  const ki = await owner.request(
    `/api/memorials/${m.id}/members`,
    "POST",
    { email: "stranger@example.test", role: "keeper" },
    201,
  );
  await stranger.request(
    "/api/invitations/" + new URL(ki.inviteUrl).hash.split("/").at(-1),
    "POST",
    {},
  );
  let keeperView = await stranger.request("/api/memorials/" + m.id);
  assert.equal(keeperView.role, "keeper");
  await stranger.request(
    `/api/memorials/${m.id}/members/${vi.id}`,
    "PATCH",
    { role: "keeper" },
    403,
  );
  await stranger.request(
    "/api/memorials/" + m.id,
    "DELETE",
    { confirm: m.name },
    403,
  );
  m = await stranger.request("/api/memorials/" + m.id, "PATCH", {
    ...keeperView,
    message: "Kept by family.",
  });
  await owner.request(`/api/memorials/${m.id}/members/${vi.id}`, "PATCH", {
    role: "contributor",
  });
  await owner.request(`/api/memorials/${m.id}/members/${vi.id}`, "PATCH", {
    role: "viewer",
  });
  checks.push(
    "co-keeper can manage; only original owner grants co-keepers or deletes memorial",
  );
  await patch({ status: "archived" });
  await owner.request(
    `/api/memorials/${m.id}/memories`,
    "POST",
    { title: "Paused", story: "Paused", media_ids: [] },
    403,
  );
  await owner.request(
    `/api/memorials/${m.id}/candles`,
    "POST",
    { message: "Paused", anonymous: true },
    403,
  );
  await stranger.request("/api/memorials/" + m.id);
  await viewer.request("/api/memorials/" + m.id, "GET", undefined, 404);
  await owner.request(
    "/api/memorials/" + m.id,
    "PATCH",
    { ...m, status: "published" },
    400,
  );
  await patch({ status: "draft" });
  await viewer.request("/api/memorials/" + m.id, "GET", undefined, 404);
  await patch({ status: "published" });
  await viewer.request("/api/memorials/" + m.id);
  checks.push(
    "archive pauses all contributions; restore stays unpublished until visibility review",
  );
  await owner.request(
    "/api/memorials/" + m.id,
    "DELETE",
    { confirm: "Wrong name" },
    400,
  );
  const originals = await readdir(resolve(scratch, "media"));
  const blocked =
    originals.find(
      (name) => name.startsWith(file.id) && name.includes("original"),
    ) || originals[0];
  const blockedPath = resolve(scratch, "media", blocked),
    backup = resolve(scratch, "blocked-backup");
  await rename(blockedPath, backup);
  await mkdir(blockedPath);
  const deleted = await owner.request("/api/memorials/" + m.id, "DELETE", {
    confirm: m.name,
  });
  assert.equal(deleted.cleanupPending, true);
  assert((await owner.request("/api/cleanup")).pending > 0);
  await stop();
  await start();
  assert((await owner.request("/api/cleanup")).pending > 0);
  await rm(blockedPath, { recursive: true });
  await rename(backup, blockedPath);
  assert.equal((await owner.request("/api/cleanup", "POST")).pending, 0);
  checks.push(
    "failed photo unlink remains queued across restart and retries successfully",
  );
  await owner.request("/api/memorials/" + m.id, "GET", undefined, 404);
  assert.equal((await readdir(resolve(scratch, "media"))).length, 0);
  checks.push(
    "confirmed deletion removes database content and all stored photos",
  );
  for (const theme of ["A", "B", "C"])
    for (const setting of ["house", "garden"])
      assert.equal(
        (await fetch(`${origin}/assets/img/${theme}_${setting}.jpg`)).status,
        200,
      );
  for (const species of [
    "dog",
    "cat",
    "rabbit",
    "bird",
    "guinea",
    "horse",
    "turtle",
  ])
    for (const finish of ["bronze", "glaze", "marble", "photo"])
      assert.equal(
        (await fetch(`${origin}/assets/img/species/${species}_${finish}.jpg`))
          .status,
        200,
      );
  checks.push(
    "all six scene backgrounds and 28 catalogue sculpture images served",
  );
  console.log(
    JSON.stringify(
      { status: "passed", checks, emailsSent: 0, isolatedDatabase: true },
      null,
      2,
    ),
  );
  const result = process.env.VERIFICATION_OUTPUT;
  if (result)
    await writeFile(
      result,
      JSON.stringify(
        { status: "passed", checks, emailsSent: 0, isolatedDatabase: true },
        null,
        2,
      ) + "\n",
    );
} catch (error) {
  console.error("Integration journey failed:", error);
  console.error(logs);
  process.exitCode = 1;
} finally {
  await stop();
  if (!process.env.KEEP_VERIFICATION_DATA)
    await rm(scratch, { recursive: true, force: true });
  else console.log("Verification data:", scratch);
}
