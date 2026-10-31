import { takeOrientation } from "./orientation";

const MAX_BYTES = 20_000_000;
const MAX_PIXELS = 40_000_000;

class InputError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function fail(status: number, message: string): never {
  throw new InputError(status, message);
}

function cropValue(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const value = Number(url.searchParams.get(name) ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max)
    fail(400, "Invalid portrait frame.");
  return value;
}

// The Images binding retains copyright EXIF; display JPEGs must contain no private metadata.
function withoutMetadata(body: ReadableStream<Uint8Array>) {
  let pending = new Uint8Array();
  let started = false;
  let scanning = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (scanning) {
          controller.enqueue(chunk);
          return;
        }
        const joined = new Uint8Array(pending.length + chunk.length);
        joined.set(pending);
        joined.set(chunk, pending.length);
        pending = joined;
        if (!started) {
          if (pending.length < 2) return;
          if (pending[0] !== 0xff || pending[1] !== 0xd8)
            throw Error("Invalid processed JPEG.");
          controller.enqueue(pending.subarray(0, 2));
          pending = pending.subarray(2);
          started = true;
        }
        while (pending.length >= 2) {
          if (pending[0] !== 0xff)
            throw Error("Invalid processed JPEG marker.");
          const marker = pending[1];
          if (marker === 0xda) {
            scanning = true;
            controller.enqueue(pending);
            pending = new Uint8Array();
            return;
          }
          if (pending.length < 4) return;
          const length = 2 + pending[2] * 256 + pending[3];
          if (length < 4) throw Error("Invalid processed JPEG segment.");
          if (pending.length < length) return;
          if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe)
            controller.enqueue(pending.subarray(0, length));
          pending = pending.subarray(length);
        }
      },
      flush() {
        if (!scanning) throw Error("Incomplete processed JPEG.");
      },
    }),
  );
}

export default {
  async fetch(request, env) {
    try {
      if (!env.PROCESSOR_TOKEN) fail(503, "Image processor is not configured.");
      const supplied = new TextEncoder().encode(
        request.headers.get("Authorization") || "",
      );
      const expected = new TextEncoder().encode(
        "Bearer " + env.PROCESSOR_TOKEN,
      );
      if (
        supplied.length !== expected.length ||
        !crypto.subtle.timingSafeEqual(supplied, expected)
      )
        fail(401, "Authentication required.");
      const url = new URL(request.url);
      if (url.pathname !== "/normalize") fail(404, "Not found.");
      if (request.method !== "POST") fail(405, "Use POST.");
      const content = request.headers.get("Content-Type") || "";
      if (!["image/jpeg", "image/png", "image/webp"].includes(content))
        fail(415, "Choose a JPG, PNG or WebP photo.");
      if (Number(request.headers.get("Content-Length") || 0) > MAX_BYTES)
        fail(413, "Choose a photo under 20 MB.");
      if (!request.body) fail(400, "Choose a photo.");
      const purpose = url.searchParams.get("purpose") || "album";
      if (!["portrait", "album", "reference"].includes(purpose))
        fail(400, "Invalid photo purpose.");
      const zoom = cropValue(url, "zoom", 1, 1, 3);
      const x = cropValue(url, "x", 0.5, 0, 1);
      const y = cropValue(url, "y", 0.5, 0, 1);

      let received = 0;
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_BYTES) {
            await reader.cancel();
            fail(413, "Choose a photo under 20 MB.");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      // PNG/WebP EXIF can follow the pixel data, so inspect the bounded input before decoding.
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      chunks.length = 0;
      const orientation = takeOrientation(bytes);
      const stream = () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        });
      const info = await env.IMAGES.info(stream());
      if (
        !("width" in info) ||
        !["image/jpeg", "image/png", "image/webp"].includes(info.format)
      ) {
        fail(415, "Choose a JPG, PNG or WebP photo.");
      }
      if (
        info.width < 1 ||
        info.height < 1 ||
        info.width * info.height > MAX_PIXELS
      ) {
        fail(400, "Choose a photo under 40 megapixels.");
      }
      let image = env.IMAGES.input(stream());
      if ([3, 4].includes(orientation))
        image = image.transform({ rotate: 180 });
      if ([5, 6].includes(orientation)) image = image.transform({ rotate: 90 });
      if ([7, 8].includes(orientation))
        image = image.transform({ rotate: 270 });
      if ([2, 4, 5, 7].includes(orientation))
        image = image.transform({ flip: "h" });
      const width = orientation >= 5 ? info.height : info.width;
      const height = orientation >= 5 ? info.width : info.height;
      if (purpose === "portrait") {
        const side = Math.max(1, Math.floor(Math.min(width, height) / zoom));
        const left = Math.floor((width - side) * x);
        const top = Math.floor((height - side) * y);
        image = image
          .transform({ trim: { left, top, width: side, height: side } })
          .transform({ width: 1024, height: 1024, fit: "scale-down" });
      } else
        image = image.transform({
          width: 2400,
          height: 2400,
          fit: "scale-down",
        });
      const response = (
        await image.output({ format: "image/jpeg", quality: 88, anim: false })
      ).response();
      const headers = new Headers(response.headers);
      headers.set("Content-Type", "image/jpeg");
      headers.set("Cache-Control", "private, no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("X-Source-Format", info.format);
      if (!response.body) fail(502, "Image processor returned no photo.");
      headers.delete("Content-Length");
      return new Response(withoutMetadata(response.body), { headers });
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? Number(error.code)
          : 0;
      const status =
        error instanceof InputError
          ? error.status
          : code === 9422
            ? 503
            : code >= 9400 && code < 9430
              ? 400
              : 502;
      if (status === 502)
        console.error(
          JSON.stringify({ event: "image_processing_failed", code }),
        );
      return Response.json(
        {
          error:
            error instanceof InputError
              ? error.message
              : "Photo processing is unavailable or the image could not be read.",
        },
        {
          status,
          headers: {
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;
