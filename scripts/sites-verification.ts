import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// A separate local edge fixture supplies the same trusted identity headers as Sites.
// No authentication bypass or verification endpoint is included in the application.
export async function verificationRuntime(
  directory: string,
  port: number,
  mailSink?: (request: IncomingMessage, response: ServerResponse) => void,
) {
  let local: Record<string, string | undefined> = {};
  try {
    local = parseEnv(await readFile(".env", "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const imageURL = process.env.IMAGE_PROCESSOR_URL || local.IMAGE_PROCESSOR_URL;
  const imageToken =
    process.env.IMAGE_PROCESSOR_TOKEN || local.IMAGE_PROCESSOR_TOKEN;
  if (!imageURL || !imageToken)
    throw Error(
      "Configure IMAGE_PROCESSOR_URL and IMAGE_PROCESSOR_TOKEN for the image-processing integration journey.",
    );
  let mf: Miniflare | undefined;
  let initialized = false;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    get mf() {
      if (!mf) throw Error("Verification runtime is stopped.");
      return mf;
    },
    async start() {
      const modulesDirectory = resolve("dist/server");
      const files = (
        await readdir(modulesDirectory, { recursive: true })
      ).filter((v) => /\.m?js$/.test(v) && v !== "index.js");
      const modules = await Promise.all(
        ["index.js", ...files].map(async (file) => ({
          type: "ESModule" as const,
          path: resolve(modulesDirectory, file),
          contents: await readFile(resolve(modulesDirectory, file), "utf8"),
        })),
      );
      mf = new Miniflare({
        ...convertV4MiniflareOptions({
          name: "everleaf-verification",
          modules,
          modulesRoot: modulesDirectory,
          compatibilityDate: "2026-05-15",
          compatibilityFlags: ["nodejs_compat"],
          host: "127.0.0.1",
          port,
          cf: false,
          log: new Log(LogLevel.ERROR),
          d1Databases: { DB: "everleaf-verification" },
          r2Buckets: { BUCKET: "everleaf-verification" },
          isolatedResourcePersistencePath: resolve(directory),
          ...(mailSink ? { outboundService: { node: mailSink } } : {}),
          assets: {
            directory: resolve("dist/client"),
            binding: "ASSETS",
            routerConfig: { has_user_worker: true },
          },
          bindings: {
            APP_ORIGIN: origin,
            RESEND_API_KEY: mailSink ? "fixture-never-send" : "",
            EMAIL_FROM: mailSink ? "Everleaf <sender@example.test>" : "",
            MODERATOR_EMAILS: "moderator@example.test",
            IMAGE_PROCESSOR_URL: imageURL,
            IMAGE_PROCESSOR_TOKEN: imageToken,
          },
        }),
        unsafeEnableSharedStorage: true,
        resourcePersistencePath: resolve(directory),
        enableDevRegistry: true,
      });
      await mf.ready;
      if (!initialized) {
        const db = await mf.getD1Database("DB");
        const journal = JSON.parse(
          await readFile("drizzle/meta/_journal.json", "utf8"),
        ) as { entries: { tag: string }[] };
        for (const migration of journal.entries) {
          const sql = await readFile(`drizzle/${migration.tag}.sql`, "utf8");
          await db.batch(
            sql
              .split("--> statement-breakpoint")
              .map((v) => v.trim())
              .filter(Boolean)
              .map((v) => db.prepare(v)),
          );
        }
        initialized = true;
      }
    },
    async stop() {
      await mf?.dispose();
      mf = undefined;
    },
  };
}

export function identityHeaders(email: string, name: string) {
  return {
    "oai-authenticated-user-id":
      "fixture-" +
      createHash("sha256").update(email).digest("hex").slice(0, 24),
    "oai-authenticated-user-email": email,
    "oai-authenticated-user-full-name": encodeURIComponent(name),
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  };
}
