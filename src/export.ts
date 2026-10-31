import { ZipWriter } from "@zip.js/zip.js/lib/zip-core-writer.js";
import { extname } from "node:path";
import { current } from "./runtime.ts";
import type { Memorial, Media } from "./types.ts";

export async function memorialExport(
  memorial: Memorial,
  files: Media[],
  memories: unknown,
) {
  const entries: { name: string; key?: string; bytes?: Uint8Array }[] = [
    {
      name: "memorial.json",
      bytes: new TextEncoder().encode(
        JSON.stringify(
          {
            ...memorial,
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
      ),
    },
    ...files.flatMap((file) => [
      { name: "photos/" + file.id + ".jpg", key: file.path },
      {
        name: "originals/" + file.id + extname(file.original_path),
        key: file.original_path,
      },
    ]),
    {
      name: "README.txt",
      bytes: new TextEncoder().encode(
        "Your memorial export includes written content, original uploaded files and metadata-stripped display photos. The supplied sculpture catalogue and scene backgrounds remain part of Everleaf.\n",
      ),
    },
  ];
  let outputController: TransformStreamDefaultController<Uint8Array>;
  const output = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      outputController = controller;
    },
  });
  const zip = new ZipWriter(output.writable, {
    zip64: true,
    level: 0,
    useWebWorkers: false,
  });
  const produce = async () => {
    for (const item of entries) {
      const source = item.bytes
        ? new Blob([item.bytes]).stream()
        : (await current().env.BUCKET.get(item.key!))?.body;
      if (!source) throw Error("An exported photo is unavailable.");
      await zip.add(item.name, source);
    }
    await zip.close();
  };
  current().ctx.waitUntil(
    produce().catch((error) => outputController.error(error)),
  );
  return output.readable;
}
