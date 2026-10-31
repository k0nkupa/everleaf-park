# Everleaf Park

Everleaf: a cozy, endless 3D memorial park for pets. Walk an infinite Lantern Bloom park, light candles, leave toys and create a memorial that keeps its own plot.

**Stack:** Sites, Cloudflare Workers, D1, private R2, Sign in with ChatGPT, three.js and Vinext. Node.js 24+ is required for local tools.

## Quick start

```sh
npm ci --ignore-scripts
cp .env.example .dev.vars
# Set IMAGE_PROCESSOR_URL and IMAGE_PROCESSOR_TOKEN in .dev.vars.
npm run preview
```

Open the printed local URL, normally http://127.0.0.1:4881/#/. The original village is at `#/village`. The Sites development sign-in widget supplies local mock identity. Hosted visitors use Sign in with ChatGPT. There is no guest keeper or magic-link login.

Local records and objects use ignored `.wrangler/state/`. Apply the initial migration before using a fresh local database:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_round_silver_samurai.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_flimsy_orphan.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_media_integrity.sql
```

Run `npm run build` first to create that config. Apply each pending file once; do not replay it on an initialized local database. Generated assets and runtime data stay out of Git. Existing `.data/` records and personal uploads are not imported.

## Checks

```sh
npm run typecheck
npm run build
npm run verify:integration
npm run verify:browser
npm run verify:mail
npm run verify:park
npm run verify:3d   # needs a real GPU
```

No license has been chosen yet; all rights reserved.

---

## Details

A working website built from Tony’s supplied draft. Public discovery, accounts, memorial creation, uploads, publishing, memories, candles, invitations, contribution review and moderation use the same persistent backend.

## Play the 3D preview

```sh
./start-preview.sh
```

Open the printed local URL. The preview uses the supplied Blender village, all six house/garden environments and real 3D sculptures. Configure the authenticated image helper to save photographs. Email delivery remains disabled unless Resend credentials and a verified sender are deliberately configured.

- Walk with WASD or arrow keys, or tap/click the ground.
- Drag to look around. Scroll or use +/− to zoom.
- Use the on-screen arrows on a phone-sized screen.
- Choose **Create a memorial**, add a portrait, choose its sculpture/setting/theme and publish. Its name appears at a stable village plot. Select that name, then **Enter Memory House** or **Enter Stillwater**.
- The home-shaped control returns to the entrance. The memorial information panel opens the readable view and management options.

The village's existing buildings are decorative source artwork. Named markers represent saved records. Private drafts and invitation-only memorials appear only to authorized visitors. A fresh preview database has no fictional user accounts or published memorials.

## Run the built Worker locally

```sh
npm run build
npm start -- --port 4880
```

This uses the same local D1/R2 state and `.dev.vars`. The development server is the preferred local UI because it provides Sites mock sign-in. The built Worker expects identity headers from Sites dispatch.

## Configuration

Keep local secrets in ignored `.dev.vars`; configure hosted values through Sites environment settings. Verification scripts read image-helper credentials from the process environment or ignored `.env`, and always disable real email.

- `APP_ORIGIN`: exact hosted address for origin checks and invitation links. Leave empty locally to use the request origin.
- `IMAGE_PROCESSOR_URL`, `IMAGE_PROCESSOR_TOKEN`: server-only authenticated image helper. JPG, PNG and WebP inputs are limited to 20,000,000 bytes and 40 million pixels.
- `RESEND_API_KEY`, `EMAIL_FROM`: optional sending credentials and verified sender. Neither is enabled on the hosted Site by default.
- `MODERATOR_EMAILS`: comma-separated ChatGPT account emails allowed to review reports.

Keepers receive a shareable invitation link. When email is configured, delivery is queued and attempted after the request. No autonomous retry scheduler is installed; later delivery requests retry pending messages. Provider acceptance is distinct from delivery. Failed file removal stays queued and can be retried from My memorials.

## Implemented

- Public village, pet-name search, species/theme filters and a readable list.
- Sign in with ChatGPT, stable Sites identity and native sign-out.
- Persistent private drafts, validated pet details and optimistic concurrency protection.
- Seven species; stylized/naturalistic catalogue sculptures; bronze/glaze/marble finishes for stylized options.
- Independent choice of two settings and three themes; all 12 setting/theme/sculpture combinations persist.
- Real file-input uploads, portrait crop, private album/reference media, media replacement/removal and access checks.
- Original upload files retained privately; metadata-stripped display images served according to visibility.
- Drag/keyboard placement of supported keepsakes with 3D props; saved arrangements and tab-local unsaved drafts.
- Publish as public, link-only or invitation-only. Public search excludes private, link-only, draft, archived and moderated records.
- Memory creation, photo attachments, editing, removal and keeper review with public, family-only or declined decisions. Pending and family-only photos follow the same privacy rules. Names appear to visitors only with the author’s consent.
- Candles with optional anonymous attribution, seven-day expiry and one active candle per person per memorial.
- Email-bound visitor/contributor/co-keeper invitations, acceptance, role changes, expiry, resend and revocation. Only the original owner can grant or revoke co-keeper access.
- Keeper home, contribution queue, visibility settings and archive. Archiving pauses contributions; restoring opens an unpublished draft for visibility review. Confirmed permanent deletion is restricted to the original owner. Failed photo cleanup stays queued across restarts and can be retried from the private home page.
- Reports, moderator-only review, scoped reversible photo/memory hiding, recorded reasons and protection against republishing around moderation.
- Keeper-only ZIP export containing written content, original uploaded files and display photographs.
- Responsive phone layouts and readable alternatives to the spatial views.

## Scope clarification

Tony chose the existing sculpture collection instead of a photo-to-3D provider. “Naturalistic” therefore selects a supplied catalogue sculpture; an uploaded portrait does not generate a likeness. There is no generation queue or fake generation-success screen.

Tony subsequently supplied nine actual Blender project files. The live preview now uses optimized GLB exports from those files, with separate portrait surfaces and replaceable sculptures. It supports movement, camera controls, obstacle boundaries, saved village locations and entering the selected environment. The six environments retain their source geometry; mesh simplification is disabled. Compression reduces file size without deleting the house walls or small props.

Source files remain in `/Users/tony/Downloads/everleaf_blender/` and are never saved over. Each scene manifest records its source hash. `scripts/export-blender.py` performs the Blender conversion; `docs/model-optimization.json` records before/after sizes. The generated model files are included so starting the preview does not require re-exporting Blender scenes.

Procedural grain is simplified to the source material palette and lighting is adapted for live rendering. The two supplied dog sculptures have different meshes; the other six species are extracted from the village and share their extracted shape across finish treatments. This does not generate a likeness from an uploaded photograph. Collision boundaries are simplified for navigation, rather than a full physics simulation.

## Verification

```sh
npm run typecheck
npm run build
npm run verify:integration
npm run verify:browser
npm run verify:mail
npm run verify:park
npm run verify:3d
```

No unit/Jest suites or hooks are used. The HTTP integration journey starts the built Worker with isolated D1 and R2, checks privacy/roles/files/actual persistence, restarts the server and verifies retained state, then removes its data. Browser journeys supply fictional identity headers at a local edge fixture and open temporary Chrome profiles and exercises real forms, file upload/crop, saving, public visiting, contribution review, invitations, all six theme/setting scenes, phone layouts, export and deletion.

The 3D check additionally covers actual WebGL output, GPU errors, collision, camera reset, all six environments, both dog meshes, all seven species, stable plots, anonymous/private access and phone controls. Canvas pixel checks ensure that submitted geometry actually appears on screen.

Local identity fixtures check app authorization; they do not prove hosted ChatGPT login. The browser checks use installed Chrome. Set `CHROME_PATH` on other machines. It drives the actual HTML file input, not the native operating-system file dialog. Verification results are in `docs/verification-*.json`; selected screenshots are in `docs/screenshots/`.

## Hosting limits

The initial Site is owner-private and starts empty. Broader access and paid services need separate authority. Sign-in is handled by Sites dispatch. Media is stored in private R2 and served only through application authorization. The image helper has its own authenticated Worker; its platform quotas apply. Account billing-plan inspection was unavailable, and no paid upgrade was made.

Phone verification uses a browser viewport, not physical phone hardware. Automated checks disable real email; actual sender delivery remains unverified. No 250-photo maximum-size export load check has been performed.

The supplied village backgrounds contain decorative memorial structures. Only named markers/results loaded from the database represent published memorials. A fresh database starts empty; no fictional accounts or activity are presented as real.

## Source and review

`docs/approved-draft.js` and its asset provenance retain the supplied design reference. `docs/IMPLEMENTATION.md` records the implementation scope and later clarifications. The import commit is the fixed baseline for the final Standards and Spec reviews. The migration review baseline is the image-helper commit `e8bf76d`; the approved migration decisions are recorded in `docs/IMPLEMENTATION.md`. Sites stores a matching source commit and deployment archive.
