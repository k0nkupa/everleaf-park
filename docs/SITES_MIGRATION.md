# Sites migration: compatibility checkpoint

Status: first compatibility gate needs an infrastructure decision. The
application has not been migrated or deployed. Checked on 31 October 2026.

## Approved direction

- Preserve the existing frontend, 3D assets, memorial workflows and access rules.
- Use Sites hosting, D1 records, private R2 media and Sign in with ChatGPT.
- Start with an empty hosted database. Do not import local personal media.
- Preserve JPG/PNG/WebP, orientation correction, portrait crop,
  metadata-stripped display JPEGs and private originals. The current code accepts
  up to 25 MiB and 40 million pixels (`src/server.ts:557` and `src/server.ts:560`).
  Tony subsequently allowed a lower upload limit and asked to investigate managed
  Cloudflare Images. No new limit has been implemented yet.
- Verify through HTTP and browser journeys. No unit tests, Jest or application
  test hooks. Review before committing and publishing.

The implementation plan places image/export compatibility before migrating all
routes. That gate found an unresolved image-processing dependency; broad backend
changes have therefore not started. The existing local application is intact.

## What was checked

All runtime checks used disposable, ignored `scratch/` files and fictional probe
data. No production resources were changed. No email, personal photos or secrets
were used in the probes. Cloudflare account checks were read-only.

| Check | Result |
| --- | --- |
| Sites full-stack starter setup | Portable starter prepared in `scratch/sites-starter`; not copied over the application |
| Local Worker runtime | Miniflare `4.20260730.0`, compatibility date `2026-07-30` |
| D1 round trip | Created a probe table, inserted `value=1`, read back `1` |
| R2 round trip | Stored `everleaf`, read back `everleaf` |
| Published `wasm-vips` package | Version `0.0.19`, browser ESM loader and statically compiled Wasm module |
| Image library initialization in Worker | Failed with `ReferenceError: Worker is not defined`, before processing an image |
| Worker/R2 ZIP round trip | Passed with `fflate` `0.8.2`: streamed an R2 object into a ZIP response, downloaded and unpacked it, and compared all 640,000 fixture bytes |
| Connected Cloudflare accounts | Personal account `The Ton Le Account` has a Workers subdomain; no resources changed |
| Cloudflare subscription inspection | Unavailable: OAuth connection received HTTP 403; billing-read scope requires a separate API token |

The Wasm initialization passed `dynamicLibraries: []` (JXL and HEIF are not
accepted upload formats) and an `instantiateWasm` callback using a statically
imported `WebAssembly.Module`. This avoids relying on unsupported dynamic Wasm
compilation or browser file loading. The failure occurs while creating the
package's pthread worker pool.

Sanitized output from the separate D1/R2 runtime probe:

```json
{"sharedArrayBuffer":"function","workerThreads":"undefined","sharedWasmMemory":268435456,"d1":1,"r2":"everleaf"}
```

Local workerd allowed that shared-memory allocation. This is not evidence that
the published Worker would fit its hosted memory limit. No hosted image pipeline
was tested.

Sanitized output from the actual image-library initialization:

```json
{"ok":false,"error":"Worker is not defined"}
```

## Why the image gate is blocked

Native `sharp` cannot simply be bundled into a Worker. The inspected alternative,
`wasm-vips`, does support demand-driven streaming: a large image does not always
require its entire decoded bitmap in memory. A full-frame memory estimate alone
would therefore be insufficient grounds to reject it.

However, its published build creates a 256 MiB initial Wasm memory and uses a
pthread pool. Worker threads are unavailable in the tested runtime, matching the
documented absence of Web Worker support. Its initial memory also exceeds the
hosted 128 MB isolate limit. A bespoke single-threaded libvips build would be a
separate investigation, not a proven dependency for this migration.

Cloudflare's managed Images binding accepts raw streams up to 20 MB. Tony has
allowed a lower upload limit. Recommend a conservative 20,000,000-byte limit,
rather than treating the documentation's MB as MiB. The installed Sites hosting
manifest documents D1 and R2 bindings; direct Images binding support in Sites has
not been established. Do not add an undocumented binding to the Site manifest.

Browser-only image processing is not a substitute for server-side validation of
untrusted uploads. No upload limit, privacy check or validation was weakened.

## Proposed managed Images integration

Keep the app, D1 and private R2 media on Sites. Add one small authenticated
Cloudflare Worker in `The Ton Le Account`, proposed name
`everleaf-image-processor`, with an `IMAGES` binding. Sites would call this helper
over HTTPS using a server-only secret. Reject unauthenticated requests before
consuming image-processing capacity; validate both byte and decoded-pixel limits.
Do not accept source URLs or provide a public image proxy.

The helper would validate format/dimensions, normalize orientation, apply crop
and zoom, remove metadata and return a JPEG stream. Sites would store that stream
and the untouched original in private R2. Visitor requests would continue to pass
Everleaf's authorization checks. No public original URLs or hosted Images storage
are required. Exact EXIF/crop/zoom equivalence must be demonstrated with fixtures
before this gate passes; merely accepting `.transform()` parameters is insufficient.

Cloudflare's Images Free plan permits 5,000 unique transformations per month.
New transformations fail after the free limit; the Free plan does not bill an
overage. Images Paid permits more, at $0.50 per 1,000 beyond the included 5,000.
Calls to `.info()` are free. Recommend staying on Images Free, with no paid-plan
purchase or upgrade. Worker request/CPU quotas are separate; the existing account
subscription could not be verified through the OAuth connection.

Creating this helper adds infrastructure outside the approved Sites deployment,
so it needs Tony's decision. No Worker, binding, secret, subscription or Site was
created or changed. The 20,000,000-byte limit is proposed, not implemented.

The hosted Images REST upload alternative is less suitable: it has a 10 MB input
limit and introduces another hosted copy; flexible variants do not support signed
private delivery. It does not replace the private raw-stream binding approach.

Once resolved, resume the approved slices: one signed-in draft persisted through
D1, concurrency-safe publishing/plot allocation, R2 uploads and contributions,
exports/deletion/retries, full integration/browser verification, Standards/Spec
review, built-in Codex review and private Sites publication. Keep anonymous
viewing possible when public Site access is separately enabled.

## Sources

- [wasm-vips usage and streaming model](https://github.com/kleisauke/wasm-vips)
- [wasm-vips build settings](https://github.com/kleisauke/wasm-vips/blob/master/src/meson.build)
- [Workers WebAssembly support](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)
- [Workers memory limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Images binding and input limits](https://developers.cloudflare.com/images/optimization/binding/)
- [Cloudflare Images pricing and free-plan limit](https://developers.cloudflare.com/images/pricing/)
- [Cloudflare Images upload limits](https://developers.cloudflare.com/images/get-started/limits/)
- [Flexible variant access restrictions](https://developers.cloudflare.com/images/optimization/hosted-images/enable-flexible-variants/)

Sources describe platform/package behavior; the local runtime outputs above are
the evidence collected for this project. No managed image-normalization or
complete memorial ZIP-export success is claimed. The ZIP proof covers a synthetic
R2 object, not a migrated application or a maximum-size 250-photo archive.
