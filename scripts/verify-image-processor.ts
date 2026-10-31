import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";

const origin = process.env.IMAGE_PROCESSOR_URL;
const secret = process.env.IMAGE_PROCESSOR_TOKEN;
assert(
  origin && secret,
  "Configure IMAGE_PROCESSOR_URL and IMAGE_PROCESSOR_TOKEN.",
);
assert(
  new URL(origin).protocol === "https:" ||
    new URL(origin).hostname === "127.0.0.1",
);
const checks: string[] = [];

async function request(
  bytes: Uint8Array,
  content = "image/jpeg",
  query = "",
  authenticated = true,
) {
  return fetch(origin + "/normalize" + query, {
    method: "POST",
    headers: {
      "Content-Type": content,
      ...(authenticated ? { Authorization: "Bearer " + secret } : {}),
    },
    body: new Uint8Array(bytes).buffer,
    signal: AbortSignal.timeout(60000),
  });
}

const rgb = Buffer.alloc(600 * 300 * 3);
for (let y = 0; y < 300; y++)
  for (let x = 0; x < 600; x++) {
    const color =
      y < 150
        ? x < 300
          ? [240, 20, 20]
          : [20, 20, 240]
        : x < 300
          ? [20, 220, 20]
          : [240, 220, 20];
    rgb.set(color, (y * 600 + x) * 3);
  }
const base = () =>
  sharp(rgb, { raw: { width: 600, height: 300, channels: 3 } });
const jpeg = await base().jpeg().toBuffer();
assert.equal((await request(jpeg, "image/jpeg", "", false)).status, 401);
assert.equal((await request(jpeg, "image/svg+xml")).status, 415);
assert.equal(
  (await request(new TextEncoder().encode("not an image"))).status,
  400,
);
assert.equal(
  (await request(jpeg, "image/jpeg", "?purpose=portrait&zoom=4")).status,
  400,
);
assert.equal((await request(new Uint8Array(20_000_001))).status, 413);
let chunksSent = 0;
const chunkedOptions = {
  method: "POST",
  headers: { Authorization: "Bearer " + secret, "Content-Type": "image/jpeg" },
  body: new ReadableStream({
    pull(controller) {
      if (++chunksSent <= 21) controller.enqueue(new Uint8Array(1_000_000));
      else controller.close();
    },
  }),
  duplex: "half",
  signal: AbortSignal.timeout(60000),
};
const chunked = await fetch(origin + "/normalize", chunkedOptions);
assert.equal(
  chunked.status,
  413,
  "actual chunked bytes are capped without Content-Length",
);
checks.push(
  "chunked upload without Content-Length is rejected after the actual byte limit",
);
const huge = await sharp({
  create: { width: 8000, height: 5001, channels: 3, background: "white" },
})
  .png()
  .toBuffer();
assert.equal((await request(huge, "image/png")).status, 400);
checks.push(
  "authentication, format, corrupt input, crop, byte and pixel limits reject invalid requests",
);

for (const format of ["jpeg", "png", "webp"] as const) {
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const input = await base()
      .toFormat(format)
      .withMetadata({ orientation })
      .withExifMerge({
        IFD0: {
          Artist: "Everleaf synthetic fixture",
          Copyright: "PRIVATE FIXTURE",
        },
      })
      .toBuffer();
    const r = await request(
      input,
      "image/" + format,
      "?purpose=portrait&zoom=2&x=0.8&y=0.2",
    );
    assert.equal(
      r.status,
      200,
      `${format}/${orientation}: ${r.ok ? "" : await r.text()}`,
    );
    const actual = Buffer.from(await r.arrayBuffer());
    const metadata = await sharp(actual).metadata();
    assert.equal(metadata.format, "jpeg");
    assert(
      !metadata.exif && !metadata.xmp && !metadata.iptc,
      "display image strips private metadata",
    );
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    assert.equal(r.headers.get("content-type"), "image/jpeg");
    assert.equal(r.headers.get("x-source-format"), "image/" + format);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    const rotated = await sharp(input)
      .rotate()
      .toBuffer({ resolveWithObject: true });
    const side = Math.floor(
      Math.min(rotated.info.width, rotated.info.height) / 2,
    );
    const expected = await sharp(rotated.data)
      .extract({
        left: Math.floor((rotated.info.width - side) * 0.8),
        top: Math.floor((rotated.info.height - side) * 0.2),
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
    assert.equal(metadata.width, side);
    assert.equal(metadata.height, side);
    const a = await sharp(actual).resize(32, 32).removeAlpha().raw().toBuffer();
    const b = await sharp(expected)
      .resize(32, 32)
      .removeAlpha()
      .raw()
      .toBuffer();
    const error =
      a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
    assert(
      error < 12,
      `${format}/${orientation}: portrait differs from current Sharp pipeline (mean pixel error ${error.toFixed(2)})`,
    );
    checks.push(
      `${format} orientation ${orientation}: private metadata removed and off-center zoomed crop matches existing pipeline`,
    );
  }
}
const album = await request(jpeg);
assert.equal(album.status, 200);
const albumMeta = await sharp(
  Buffer.from(await album.arrayBuffer()),
).metadata();
assert.equal(albumMeta.width, 600);
assert.equal(albumMeta.height, 300);
checks.push("album keeps aspect ratio and does not enlarge a small photo");
const atByteLimit = new Uint8Array(20_000_000);
atByteLimit.set(jpeg);
const byteBoundary = await request(atByteLimit);
assert.equal(byteBoundary.status, 200, "20 MB boundary");
await byteBoundary.arrayBuffer();
checks.push("20,000,000-byte JPEG accepted; one additional byte rejected");
const fortyMP = await sharp({
  create: { width: 8000, height: 5000, channels: 3, background: "#785634" },
})
  .jpeg()
  .toBuffer();
const pixelBoundary = await request(fortyMP);
assert.equal(pixelBoundary.status, 200);
const pixelMeta = await sharp(
  Buffer.from(await pixelBoundary.arrayBuffer()),
).metadata();
assert.equal(pixelMeta.width, 2400);
assert.equal(pixelMeta.height, 1500);
checks.push(
  "40-megapixel input accepted and scaled to 2400px; larger input rejected",
);
const result = { checkedAt: new Date().toISOString(), origin, checks };
if (process.env.VERIFICATION_OUTPUT)
  await writeFile(
    process.env.VERIFICATION_OUTPUT,
    JSON.stringify(result, null, 2) + "\n",
  );
console.log(JSON.stringify(result, null, 2));
