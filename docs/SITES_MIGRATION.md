# Sites migration

Status: application migrated locally; typecheck, build, HTTP, browser, park and 3D checks pass. Independent Standards/Spec review and the final built-in focused review found no remaining blocker. Private Sites publication follows this source checkpoint. Updated on 31 October 2026.

## Approved direction and implementation

- Preserve the frontend, 3D assets, memorial workflows and access rules.
- Sites hosts the Worker. D1 replaces SQLite files; private R2 replaces local media. The first hosted database is empty. Local `.data` and personal media are not imported.
- Sign in with ChatGPT replaces magic links and guest sessions. Ownership and accepted member roles use the stable Sites user ID. Pending invitations use the recipient's ChatGPT email. Initial publication is owner-private.
- Image uploads accept JPG/PNG/WebP up to 20,000,000 bytes and 40 million pixels. Originals remain private. Display JPEGs preserve orientation/crop behavior and remove metadata. Exports stream originals, display photographs and written content through keeper authorization, with ZIP64 records for large archives.
- D1 batches/counters preserve plot allocation; guarded writes prevent duplicate candles, plot claims and invitation acceptance. Durable row leases coordinate mail and R2 cleanup. No timer or autonomous retry scheduler is installed. Keepers can retry failed cleanup from My memorials; pending email is retried on later delivery requests.
- Real email is opt-in. No Resend credentials were added to Sites. Keepers can copy authorized invitation links without claiming email delivery.
- No unit/Jest tests or application test hooks. Checks use typechecking, build, real Worker/D1/R2 HTTP journeys, browser journeys and the live image helper. Local identity fixtures do not prove hosted ChatGPT sign-in.

## Image helper: deployed and verified

Tony approved `everleaf-image-processor` in `The Ton Le Account` at `https://everleaf-image-processor.the-ton-le-account.workers.dev`. It has an Images binding and server-only bearer secret. Anonymous requests return 401. No subscription or paid upgrade was changed. Account billing-plan inspection was unavailable through the connected OAuth permissions; free-tier eligibility is not asserted.

Source is in `services/image-processor/`. `POST /normalize?purpose=portrait|album|reference` accepts optional portrait `zoom` (1–3), `x` and `y` (0–1). PNG/WebP EXIF can be at the end, so bounded input is buffered before orientation is made explicit. Output metadata is removed while streaming; responses are `private, no-store`. `IMAGE_PROCESSOR_URL` and `IMAGE_PROCESSOR_TOKEN` exist only in ignored local configuration and the Sites runtime environment.

`npm run verify:images` exercised the actual helper with synthetic fixtures: all eight EXIF orientations in JPEG/PNG/WebP, metadata removal, crop/zoom comparison against Sharp, album aspect ratio and no enlargement, authentication, MIME/corrupt input and crop bounds. Exact 20,000,000-byte and 40-million-pixel inputs passed; larger inputs failed. See `docs/verification-image-processor.json`.

## Migration evidence

The migrated HTTP integration checks pass against the built Worker with disposable D1 and R2, including privacy/roles, original bytes, moderation, invitations, export, restart persistence and cleanup. Parallel requests also check unique plot allocation/claims, one candle per person, single-use invitations and the 250-photo cap. Owner and contributor profile changes retain roles; another account with the former email receives no role. Python zipfile independently reads the ZIP64 export, validates CRCs and compares the original photo bytes. See `docs/verification-integration.json`. Photo attachment/deletion and keeper-review/moderator-hide races preserve media and privacy invariants. The isolated provider journey in `docs/verification-mail.json` proves that a later invitation retries a failed message with the same idempotency key; no real email leaves the fixture.

Browser, park and 3D journeys passed against the migrated Worker. The 3D journey loaded all six environments and all 17 required models, checked camera/collision movement, stable plots and phone controls. Hosted sign-in and deployment acceptance are recorded separately from local fixtures. Maximum 250-photo export load, physical phone hardware and actual email delivery remain outside this verification.

The investigation below is historical evidence of why the approved image helper was needed.

## Initial compatibility checks (before helper approval)

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

## Why the initial image gate was blocked

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

## Initial managed Images proposal (subsequently approved above)

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

At this initial checkpoint, creating a helper outside Sites awaited Tony's
decision. No Worker, binding, secret, subscription or Site had been created or
changed, and the 20,000,000-byte limit was only proposed. The approved helper
implementation is recorded at the top of this document.

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
the evidence collected for this project. The initial ZIP proof covered a synthetic R2 object. The later migrated HTTP journey verifies a complete memorial export, but not a maximum-size 250-photo archive.

- [ZIP64 and streaming writer options](https://gildas-lormeau.github.io/zip.js/api/interfaces/ZipWriterConstructorOptions.html)
