import { execFileSync } from "node:child_process";
import { verificationRuntime, identityHeaders } from "./sites-verification.ts";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
let checks: string[] = [];
const runtime = await verificationRuntime(scratch, port);
const start = () => runtime.start(),
  stop = () => runtime.stop();
function client() {
  return {
    headers: {} as Record<string, string>,
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
          ...this.headers,
          ...(data ? { "Content-Type": "application/json" } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
        redirect: "manual",
      });
      const raw = await r.text();
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        throw Error(
          `Non-JSON response: ${method} ${path}: ${r.status} ${raw.slice(0, 100)}`,
        );
      }
      assert.equal(
        r.status,
        expected,
        `${method} ${path}: ${JSON.stringify(body)}`,
      );
      return body;
    },
    async login(email: string, name: string) {
      this.headers = identityHeaders(email, name);
      const session = await this.request("/api/session");
      assert.equal(session.user.email, email);
      assert.equal(
        session.emailConfigured,
        false,
        "Email must stay disabled during verification",
      );
      checks.push("Sites identity fixture: " + name);
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
        ...who.headers,
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
      ...owner.headers,
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
    Buffer.from(
      await (await (
        await runtime.mf.getR2Bucket("BUCKET")
      ).get(file.id + ".original.jpg"))!.arrayBuffer(),
    ),
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
        ...owner.headers,
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
  const accepts = await Promise.all(
    Array.from({ length: 2 }, () =>
      fetch(origin + "/api/invitations/" + vt, {
        method: "POST",
        headers: {
          Origin: origin,
          ...viewer.headers,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    ),
  );
  assert.equal(accepts.filter((r) => r.status === 200).length, 1);
  assert(accepts.every((r) => [200, 404, 409].includes(r.status)));
  await Promise.all(accepts.map((r) => r.text()));

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
  alex.headers = {
    ...alex.headers,
    "oai-authenticated-user-email": "alex-renamed@example.test",
  };
  assert.equal(
    (await alex.request("/api/memorials/" + m.id)).role,
    "contributor",
  );
  assert(
    (await alex.request("/api/memorials?mine=1")).items.some(
      (v: Memorial) => v.id === m.id,
    ),
  );
  const recycled = client();
  recycled.headers = {
    ...identityHeaders("alex@example.test", "Different account"),
    "oai-authenticated-user-id": "fixture-recycled-email",
  };
  await recycled.request("/api/memorials/" + m.id, "GET", undefined, 404);
  checks.push(
    "accepted contributor keeps access after email change; another Sites account with the former email receives no role",
  );
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
  const lit = await Promise.all(
    Array.from({ length: 4 }, () =>
      fetch(origin + `/api/memorials/${m.id}/candles`, {
        method: "POST",
        headers: {
          Origin: origin,
          ...alex.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ anonymous: true, message: "For our friend." }),
      }),
    ),
  );
  assert.deepEqual(lit.map((r) => r.status).sort(), [200, 200, 200, 201]);
  const litBodies = await Promise.all(lit.map((r) => r.json()));
  assert.equal(new Set(litBodies.map((v) => v.id)).size, 1);
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
  const moderationRace = await Promise.all([
    fetch(origin + "/api/reports/" + report.id, {
      method: "PATCH",
      headers: {
        Origin: origin,
        ...moderator.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "hide_memory",
        reason: "Privacy review.",
      }),
    }),
    fetch(origin + `/api/memorials/${m.id}/memories/${memory.id}`, {
      method: "PATCH",
      headers: {
        Origin: origin,
        ...owner.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ decision: "approved" }),
    }),
  ]);
  assert.equal(moderationRace[0].status, 200);
  assert([200, 400, 409].includes(moderationRace[1].status));
  await Promise.all(moderationRace.map((r) => r.text()));
  checks.push("a concurrent keeper review cannot reverse moderator hiding");
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
    headers: { ...owner.headers },
  });
  assert.equal(archive.status, 200);
  assert(archive.headers.get("content-type")?.includes("zip"));
  const bytes = Buffer.from(await archive.arrayBuffer());
  assert(bytes.includes(Buffer.from("memorial.json")));
  assert(bytes.includes(Buffer.from(file.id + ".jpg")));
  assert(bytes.includes(Buffer.from("originals/" + file.id + ".jpg")));
  assert(
    bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])),
    "ZIP64 end record is present",
  );
  await writeFile(resolve(scratch, "export.zip"), bytes);
  execFileSync("python3", [
    "-c",
    `import sys,json,zipfile,pathlib
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 assert json.loads(z.read('memorial.json'))['id']==sys.argv[2]
 assert z.read('originals/'+sys.argv[3]+'.jpg')==pathlib.Path(sys.argv[4]).read_bytes()
`,
    resolve(scratch, "export.zip"),
    m.id,
    file.id,
    resolve("public/assets/img/A0.jpg"),
  ]);
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
    "D1 records, arrangement and candle survive a Worker restart; supplied Sites identity retains access",
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
  const deleted = await owner.request("/api/memorials/" + m.id, "DELETE", {
    confirm: m.name,
  });
  assert.equal(deleted.cleanupPending, false);
  // Provision an interrupted-upload fixture at the storage seam, not an app-only failure hook.
  const bucket = await runtime.mf.getR2Bucket("BUCKET");
  await bucket.put("interrupted-upload.original.jpg", "synthetic orphan");
  const db = await runtime.mf.getD1Database("DB");
  await db
    .prepare(
      "INSERT INTO file_cleanup(path,requested_by,attempts,error,created_at) VALUES(?,?,1,?,?)",
    )
    .bind(
      "interrupted-upload.original.jpg",
      m.owner_id,
      "Interrupted upload",
      Date.now(),
    )
    .run();
  assert((await owner.request("/api/cleanup")).pending > 0);
  await stop();
  await start();
  assert((await owner.request("/api/cleanup")).pending > 0);
  assert.equal((await owner.request("/api/cleanup", "POST")).pending, 0);
  checks.push(
    "interrupted R2 upload cleanup remains queued across restart and retries successfully",
  );
  await owner.request("/api/memorials/" + m.id, "GET", undefined, 404);
  assert.equal(
    (await (await runtime.mf.getR2Bucket("BUCKET")).list()).objects.length,
    0,
  );
  checks.push(
    "confirmed deletion removes database content and all stored photos",
  );
  const parallel = client();
  await parallel.login("parallel@example.test", "Parallel");
  const drafts = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      parallel.request(
        "/api/memorials",
        "POST",
        { ...base, name: "Parallel " + i },
        201,
      ),
    ),
  );
  assert.equal(new Set(drafts.map((d) => d.plot_index)).size, 4);
  assert.equal(
    new Set(drafts.map((d) => `${d.park_i},${d.park_j},${d.park_k}`)).size,
    4,
  );
  const free = (await anon.request("/api/park")).free[0].key;
  const claims = await Promise.all(
    drafts.slice(0, 2).map((d) =>
      fetch(origin + `/api/park/${d.id}/place`, {
        method: "POST",
        headers: {
          Origin: origin,
          ...parallel.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plot: free, stone: "heart" }),
      }),
    ),
  );
  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 409]);
  await Promise.all(claims.map((r) => r.text()));
  const originalID = drafts[0].owner_id;
  parallel.headers = {
    ...parallel.headers,
    "oai-authenticated-user-email": "changed@example.test",
    "oai-authenticated-user-full-name": encodeURIComponent("Renamed Keeper"),
  };
  assert.equal((await parallel.request("/api/session")).user.id, originalID);
  assert.equal(
    (await parallel.request("/api/memorials/" + drafts[0].id)).role,
    "owner",
  );
  for (const d of drafts)
    await parallel.request("/api/memorials/" + d.id, "DELETE", {
      confirm: d.name,
    });
  checks.push(
    "parallel creation and plot claims stay unique; candle and invitation races have one winner; stable Sites ID retains ownership after profile change",
  );
  const capped = await parallel.request(
    "/api/memorials",
    "POST",
    { ...base, name: "Photo cap" },
    201,
  );
  const capDB = await runtime.mf.getD1Database("DB"),
    capBucket = await runtime.mf.getR2Bucket("BUCKET");
  const capPhoto = await readFile("public/assets/img/A0.jpg");
  await capBucket.put("cap-fixture.jpg", capPhoto);
  await capBucket.put("cap-fixture.original.jpg", capPhoto);
  await capDB.batch(
    Array.from({ length: 249 }, (_, i) =>
      capDB
        .prepare(
          "INSERT INTO media(id,memorial_id,user_id,purpose,filename,path,original_path,bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          "cap-fixture-" + i,
          capped.id,
          capped.owner_id,
          "album",
          "fixture",
          "cap-fixture.jpg",
          "cap-fixture.original.jpg",
          capPhoto.length,
          Date.now(),
        ),
    ),
  );
  const capUploads = await Promise.all(
    Array.from({ length: 2 }, () =>
      fetch(
        origin +
          `/api/memorials/${capped.id}/media?purpose=album&filename=cap.jpg`,
        {
          method: "POST",
          headers: {
            Origin: origin,
            ...parallel.headers,
            "Content-Type": "image/jpeg",
          },
          body: capPhoto,
        },
      ),
    ),
  );
  assert.deepEqual(capUploads.map((r) => r.status).sort(), [201, 409]);
  await Promise.all(capUploads.map((r) => r.text()));
  assert.equal(
    (await capDB
      .prepare("SELECT COUNT(*) n FROM media WHERE memorial_id=?")
      .bind(capped.id)
      .first<{ n: number }>())!.n,
    250,
  );
  assert.equal(
    (await capBucket.list()).objects.length,
    4,
    "losing upload objects are removed",
  );
  await parallel.request("/api/memorials/" + capped.id, "DELETE", {
    confirm: capped.name,
  });
  assert.equal((await capBucket.list()).objects.length, 0);
  checks.push(
    "simultaneous uploads at 249 photos allow one winner, preserve the 250-photo cap and clean losing R2 objects",
  );
  const racing = await parallel.request(
    "/api/memorials",
    "POST",
    { ...base, name: "Attachment race" },
    201,
  );
  for (let i = 0; i < 5; i++) {
    const response = await fetch(
      origin +
        `/api/memorials/${racing.id}/media?purpose=album&filename=race.jpg`,
      {
        method: "POST",
        headers: {
          Origin: origin,
          ...parallel.headers,
          "Content-Type": "image/jpeg",
        },
        body: capPhoto,
      },
    );
    assert.equal(response.status, 201);
    const photo = await response.json();
    const pair = await Promise.all([
      fetch(origin + `/api/memorials/${racing.id}/memories`, {
        method: "POST",
        headers: {
          Origin: origin,
          ...parallel.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "Race " + i,
          story: "A photo kept with its story.",
          media_ids: [photo.id],
        }),
      }),
      fetch(origin + `/api/memorials/${racing.id}/media/${photo.id}`, {
        method: "DELETE",
        headers: { Origin: origin, ...parallel.headers },
      }),
    ]);
    assert(
      !pair.every((r) => r.ok),
      "attaching and deleting the same photo cannot both succeed",
    );
    assert(pair.every((r) => [200, 201, 400, 409].includes(r.status)));
    await Promise.all(pair.map((r) => r.text()));
  }
  assert.equal(
    (await capDB
      .prepare(
        "SELECT COUNT(*) n FROM memories,json_each(memories.media_ids) attached WHERE memorial_id=? AND NOT EXISTS(SELECT 1 FROM media WHERE id=attached.value)",
      )
      .bind(racing.id)
      .first<{ n: number }>())!.n,
    0,
  );
  await parallel.request("/api/memorials/" + racing.id, "DELETE", {
    confirm: racing.name,
  });
  assert.equal((await capBucket.list()).objects.length, 0);
  checks.push(
    "concurrent photo attachment and deletion have one winner; memory references remain valid; parent deletion still cleans all files",
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
  process.exitCode = 1;
} finally {
  await stop();
  if (!process.env.KEEP_VERIFICATION_DATA)
    await rm(scratch, { recursive: true, force: true });
  else console.log("Verification data:", scratch);
}
