# Everleaf Park

Everleaf: a cozy, endless 3D memorial park for pets. Walk an infinite Lantern Bloom park, light candles, leave toys and create a memorial that keeps its own plot.

**Stack:** Node 24 + TypeScript server, three.js, esbuild, SQLite, Playwright verify scripts.

## Quick start

```sh
npm ci
npm run preview
```

Open http://127.0.0.1:4881/#/ (the legacy village is at `#/village`).

## Checks

```sh
npm run typecheck
npm run build
npm run verify:integration
npm run verify:browser
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

Open [Everleaf preview](http://127.0.0.1:4881). This preview uses the supplied Blender village, all six house/garden environments and real 3D sculptures. Email is disabled. Creating a memorial establishes a local keeper session automatically; no email address or sign-in link is needed. Saved preview content stays in the ignored `.preview-data/` folder, separate from the original website data and configured Resend credentials.

- Walk with WASD or arrow keys, or tap/click the ground.
- Drag to look around. Scroll or use +/− to zoom.
- Use the on-screen arrows on a phone-sized screen.
- Choose **Create a memorial**, add a portrait, choose its sculpture/setting/theme and publish. Its name appears at a stable village plot. Select that name, then **Enter Memory House** or **Enter Stillwater**.
- The home-shaped control returns to the entrance. The memorial information panel opens the readable view and management options.

The village's existing buildings are decorative source artwork. Named markers represent saved records. Private drafts and invitation-only memorials appear only to authorized visitors. A fresh preview database has no fictional user accounts or published memorials.

Preview access is guarded to loopback-only development with email disabled. It refuses to start in public/production mode. Its separate cookie and database preserve the original site's sessions and data.

## Run locally

Requires Node.js 24 or newer.

```sh
npm ci --ignore-scripts
npm run build
npm start
```

Open http://127.0.0.1:4880. The server binds to this computer by default. If the system Node is older, `./start-local.sh` also recognizes the bundled Codex Node runtime.

## Configuration

Copy `.env.example` to `.env` for a new checkout. The local `.env` is ignored by Git and must stay private.

- `APP_ORIGIN`: the exact website address. Magic links and invitation links use it.
- `DATA_DIR`: SQLite database and private uploaded files. Default `.data/`.
- `RESEND_API_KEY`: sending key, kept on the server only.
- `EMAIL_FROM`: verified sender. This workspace is configured for `Everleaf <memories@ours-mine.tienwavelabs.co.nz>`.
- `MODERATOR_EMAILS`: comma-separated email addresses allowed to review reports.

The key was copied from Tony’s `EVERLEAF_RESEND_API_KEY` assignment in `~/.zshrc`. No key is included in the repository. The supplied key cannot list Resend domains, so domain verification and actual delivery have not been independently accepted.

With Resend configured, requesting sign-in or sending an invitation queues real email. This session’s automated checks deliberately disable delivery and use isolated databases; they never send to the test addresses.

Without email credentials, **loopback-only development mode** displays single-use sign-in and invitation links so the complete local flow can be exercised. This bypass is unavailable in public mode. Public mode requires an HTTPS origin and configured email. Local links open only on the computer running the server.

## Implemented

- Public village, pet-name search, species/theme filters and a readable list.
- Single-use, expiring magic-link sign-in; HTTP-only sessions; logout.
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
npm run verify:3d
```

No unit/Jest suites or hooks are used. The HTTP integration journey starts an isolated server and database, checks privacy/roles/files/actual persistence, restarts the server and verifies retained state, then removes its data. The browser journey opens temporary Chrome profiles and exercises real forms, file upload/crop, saving, public visiting, contribution review, invitations, all six theme/setting scenes, phone layouts, export and deletion.

The 3D check additionally covers actual WebGL output, GPU errors, collision, camera reset, all six environments, both dog meshes, all seven species, stable plots, anonymous/private access and phone controls. Canvas pixel checks ensure that submitted geometry actually appears on screen.

The browser checks use installed Chrome. Set `CHROME_PATH` on other machines. It drives the actual HTML file input, not the native operating-system file dialog. Verification results are in `docs/verification-*.json`; selected screenshots are in `docs/screenshots/`.

## Hosting limits

The site has not been deployed. The playable preview is bound to this computer; phone verification uses a browser viewport, not physical phone hardware. This implementation uses one Node server with a persistent SQLite/media directory; it is not suitable for an ephemeral serverless filesystem or multiple independent replicas. Back up the database and media together. Public hosting also needs HTTPS, an externally reachable `APP_ORIGIN`, verified sender delivery and deployment-specific proxy/rate-limit configuration.

The supplied village backgrounds contain decorative memorial structures. Only named markers/results loaded from the database represent published memorials. A fresh database starts empty; no fictional accounts or activity are presented as real.

## Source and review

`docs/approved-draft.js` and its asset provenance retain the supplied design reference. `docs/IMPLEMENTATION.md` records the implementation scope and later clarifications. The import commit is the fixed baseline for the final Standards and Spec reviews. This is a local Git repository; no remote, push or deployment was created.
