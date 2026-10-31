// Actual Worker HTTP journey with a local provider boundary; no real email can leave.
import { verificationRuntime, identityHeaders } from "./sites-verification.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const directory = await mkdtemp(resolve(tmpdir(), "everleaf-mail-"));
const port = await new Promise<number>((done) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address === "object");
    server.close(() => done(address.port));
  });
});
const attempts: string[] = [];
const runtime = await verificationRuntime(
  directory,
  port,
  (request, response) => {
    assert.equal(request.headers.host, "api.resend.com");
    assert.equal(request.headers.authorization, "Bearer fixture-never-send");
    attempts.push(String(request.headers["idempotency-key"]));
    request.resume();
    response.writeHead(attempts.length === 1 ? 503 : 200, {
      "Content-Type": "application/json",
    });
    response.end('{"id":"fixture"}');
  },
);
const headers = {
  ...identityHeaders("mail-keeper@example.test", "Mail Keeper"),
  Origin: runtime.origin,
  "Content-Type": "application/json",
};
async function post(path: string, data: unknown) {
  const r = await fetch(runtime.origin + path, {
    method: "POST",
    headers,
    body: JSON.stringify(data),
  });
  assert.equal(r.status, 201, await r.clone().text());
  return r.json();
}
try {
  await runtime.start();
  const db = await runtime.mf.getD1Database("DB");
  const memorial = await post("/api/memorials", {
    name: "Mail probe",
    species: "dog",
    theme: "A",
    setting: "house",
    style: "stylized",
    finish: "glaze",
    visibility: "private",
    review: true,
    arrangement: [],
  });
  const until = async (sql: string) => {
    for (let i = 0; i < 100; i++) {
      if (await db.prepare(sql).first()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error("Mail provider journey timed out");
  };
  await post(`/api/memorials/${memorial.id}/members`, {
    email: "first@example.test",
    role: "viewer",
  });
  await until("SELECT id FROM mail WHERE status='pending' AND attempts=1");
  await post(`/api/memorials/${memorial.id}/members`, {
    email: "second@example.test",
    role: "viewer",
  });
  await until(
    "SELECT COUNT(*) n FROM mail WHERE status='accepted' HAVING COUNT(*)=2",
  );
  assert.equal(attempts.length, 3);
  assert.equal(attempts[0], attempts[1]);
  assert.equal(new Set(attempts).size, 2);
  const checks = [
    "failed invitation mail stays pending; a later invitation retries it and sends the new message; retry keeps its provider idempotency key",
  ];
  await writeFile(
    "docs/verification-mail.json",
    JSON.stringify(
      {
        status: "passed",
        checks,
        emailsSent: 0,
        provider: "isolated local HTTP fixture",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ status: "passed", checks }));
} finally {
  await runtime.stop();
  await rm(directory, { recursive: true, force: true });
}
