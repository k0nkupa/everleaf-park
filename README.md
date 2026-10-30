# Everleaf

A working website built from Tony’s supplied draft. Public discovery, accounts, memorial creation, uploads, publishing, memories, candles, invitations, contribution review and moderation use the same persistent backend.

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
- Drag/keyboard placement of supported keepsake links; saved arrangements and tab-local unsaved drafts.
- Publish as public, link-only or invitation-only. Public search excludes private, link-only, draft, archived and moderated records.
- Memory creation, photo attachments, editing, removal and owner approval. Pending contributions and their photos remain private.
- Candles with optional anonymous attribution, seven-day expiry and one active candle per person per memorial.
- Email-bound contributor/visitor invitations, acceptance and revocation.
- Owner home, contribution queue, visibility settings, archive/restore and confirmed deletion.
- Reports, moderator-only review, distinct recorded moderation actions and protection against owner republishing around moderation.
- Owner-only ZIP export containing written content, original uploaded files and display photographs.
- Responsive phone layouts and readable alternatives to the spatial views.

## Scope clarification

Tony chose the existing sculpture collection instead of a photo-to-3D provider. “Naturalistic” therefore selects a supplied catalogue image; an uploaded portrait does not generate a likeness. There is no generation queue or fake generation-success screen.

The draft supplies JPEG environment/sculpture renders, not editable model assets. The website uses those renders with real navigation, content and positioned keepsake links. It does not provide real-time 3D orbit/walking, generate new sculpture geometry or physically rearrange objects baked into a background image. The catalogue inspection view and placed keepsake links accurately reflect the saved selections.

## Verification

```sh
npm run typecheck
npm run build
npm run verify:integration
npm run verify:browser
```

No unit/Jest suites or hooks are used. The HTTP integration journey starts an isolated server and database, checks privacy/roles/files/actual persistence, restarts the server and verifies retained state, then removes its data. The browser journey opens temporary Chrome profiles and exercises real forms, file upload/crop, saving, public visiting, contribution review, invitations, all six theme/setting scenes, phone layouts, export and deletion.

The browser check uses installed Chrome. Set `CHROME_PATH` on other machines. It drives the actual HTML file input, not the native operating-system file dialog. Verification results are in `docs/verification-*.json`; screenshots are retained outside the source checkout in the conversation’s work folder.

## Hosting limits

The site has not been deployed. This implementation uses one Node server with a persistent SQLite/media directory; it is not suitable for an ephemeral serverless filesystem or multiple independent replicas. Back up the database and media together. Public hosting also needs HTTPS, an externally reachable `APP_ORIGIN`, verified sender delivery and deployment-specific proxy/rate-limit configuration.

The supplied village backgrounds contain decorative memorial structures. Only named markers/results loaded from the database represent published memorials. A fresh database starts empty; no fictional accounts or activity are presented as real.

## Source and review

`docs/approved-draft.js` and its asset provenance retain the supplied design reference. `docs/IMPLEMENTATION.md` records the implementation scope and later clarifications. The import commit is the fixed baseline for the final Standards and Spec reviews. This is a local Git repository; no remote, push or deployment was created.
