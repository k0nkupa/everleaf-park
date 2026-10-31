# Final review

Fixed baseline: `2acc4a75f5a1b9698194979ebfa010e75e5340a6` (approved draft import).

Two independent read-only reviews covered the implementation against this baseline. Reviewers did not run unit tests, launch the application, read secrets or edit files. The implementation owner performed the runtime verification below.

## Standards axis

Initial result: one P2 finding; worst severity P2.

| Finding                                                             | Resolution                                                                                                                                                                                                                                                                                              | Evidence                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File deletion could lose track of private files when unlink failed. | File paths enter a durable cleanup queue in the same transaction as deletion. Failed jobs survive restart. Startup, background and private manual retries remove successful jobs. UI and API report pending cleanup. Both initial upload writes and database insertion failures use cleanup protection. | HTTP journey forces unlink failure, deletes the memorial, restarts the server, restores filesystem access and retries successfully. Reviewer confirmed the original finding and upload follow-up closed. |

Final focused follow-up: no remaining blocking Standards findings for this change.

## Spec axis

Initial result: six findings; one P1 and five P2. Worst severity P1.

| Finding                                        | Resolution                                                                                                                                                                                                       | Evidence                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| P1: Names published without consent.           | Names default to private. The author can opt in per memory. Visitors and the contributor list receive only consented names. Keepers cannot enable another person's consent.                                      | HTTP and browser journeys verify private default, explicit consent and public attribution. |
| P2: Restore silently republished.              | Restore creates an unpublished draft. The keeper must review visibility and explicitly publish. Direct archived-to-published updates fail.                                                                       | HTTP boundary checks and browser archive/restore/publish journey.                          |
| P2: Co-keeper role absent.                     | Co-keepers manage content, review, visibility, invitations, archive and export. Only the original owner grants/revokes co-keeper access or permanently deletes.                                                  | HTTP permission checks and browser role changes.                                           |
| P2: Family-only review absent.                 | Review supports keeping a memory private to the invited family. Its photos follow the same visibility rules.                                                                                                     | HTTP public/member/photo access checks.                                                    |
| P2: Photo-only moderation and reversal absent. | Moderators can hide/restore only photos attached to a reported item. The story stays available. Hidden attachments survive ordinary story edits. Restoring a hidden memory retains its prior family-only status. | HTTP hide/edit/restore journey, invalid target rejection and family privacy readback.      |
| P2: Archived owners could contribute.          | Every role is blocked from creating new memories and candles while archived. UI removes contribution actions.                                                                                                    | HTTP owner rejection and browser archive behavior.                                         |

Final focused follow-up: no remaining blocking findings within the six fixes. Reviewers confirmed the hidden-attachment follow-up closed.

## Runtime verification

- `npm run typecheck` and `npm run build` pass.
- `docs/verification-integration.json`: 31 checks covering isolated HTTP, SQLite and filesystem journeys, including server restarts and a forced deletion failure.
- `docs/verification-browser.json`: 16 journeys covering real Chrome forms, upload/crop, publish/readback, consent, role changes, six scene combinations, phone layouts, archive/restore, export and deletion.
- No unit/Jest suites or hooks were run. No real email was sent.

## Remaining acceptance limits

This is a local implementation, not a deployed service. Resend credentials are configured privately, but verified domain status and delivery are unconfirmed. The supplied environments and sculptures are rendered images, not interactive 3D model assets. Browser upload checks use the real HTML file input, not the native operating-system file picker. Backups, HTTPS/proxy behavior and hosting acceptance remain deployment work.

# Playable 3D preview review

Fixed baseline: `9f4a1c0`. Initial implementation checkpoint: `cb67e36`. The user authorized the supplied Blender files for a playable village, memorial creation and entering the memorial; email is deferred. The following reviews concern that scope.

## Standards axis — 3D

Initial review: five findings, worst severity P1. All blocking findings and targeted follow-ups were resolved.

| Finding                                                                 | Resolution                                                                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Generated-bundle rule was ambiguous for exported models.                | Clarified repo guidance: generated JavaScript stays ignored; optimized GLB models and provenance are versioned product assets needed to run the preview.     |
| Repeated scene changes did not dispose light shadow render targets.     | Teardown disposes light shadow maps, geometry, materials and textures. A single renderer/canvas is reused; old event listeners and render lists are cleared. |
| Later plot indices could exceed navigation bounds.                      | Navigation bounds, camera range and ground expand to cover the persisted locations.                                                                          |
| Return to entrance teleported the visitor without restoring the camera. | Reset restores a coherent player/camera/target/rotation tuple. The village entrance is canonical even after restoring saved walking state.                   |
| Geometry counters could accept a blank frame.                           | Browser checks now inspect actual canvas pixel coverage and WebGL error state, alongside scene readiness and saved-data readbacks.                           |

Follow-up fixes include wheel zoom for memorial views, cached shadow invalidation, and a collision check that waits for the visitor to reach the boundary before measuring a stable stop. Reviewer confirmed the remaining reset and timing findings closed by static inspection. The repeated world-mode branches were noted as a judgement call and retained to keep the three direct camera/interaction modes together.

## Spec axis — 3D

Initial review: three P2 findings; a later reset edge case was also resolved.

| Finding                                                             | Resolution                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Preview unnecessarily removed the portrait publication requirement. | Restored the requirement in server and UI. Only email/session access differs in preview.                            |
| Collision/repeated-view acceptance was not directly established.    | Real Chrome checks cover fountain blocking, entrance reset, repeated environments, rendered pixels and GPU errors.  |
| Village loaded the same pet assets serially for each record.        | Per-world asset requests are memoized and loaded in parallel; each placement receives its own transform and finish. |
| A resumed visit redefined the entrance.                             | Reset uses the canonical village entrance; resuming the camera does not apply the walking offset twice.             |

The focused static follow-up reported no remaining blocker for these findings.

## Visual review

One independent review covered desktop and phone screenshots against the supplied village and Lantern Bloom source renders. Five actionable issues were corrected, then checked visually by the implementation owner:

- Restored complete house shells and small props by disabling mesh simplification. Browser compression retains the source geometry.
- Capped projected labels to readable screen sizes and hid labels that would be clipped.
- Corrected portrait-phone framing and the duplicated resume-position camera offset.
- Wrapped sculpture controls and restored readable contrast.
- Enlarged phone touch controls to 44 pixels and separated notifications from movement instructions.

The source lighting/material character is adapted for real-time rendering; procedural grain is simplified. No new art direction was substituted for the supplied scenes.

## Final runtime evidence

- Type check and browser bundle build pass.
- `verification-integration.json`: 32 actual HTTP/database/filesystem checks, including preview access being unavailable outside explicit preview mode.
- `verification-browser.json`: 16 full website browser journeys.
- `verification-3d.json`: 12 live 3D journeys covering all 17 model files, all six environments, both dog shapes, seven species, real creation/entry, collision, camera controls, public/private boundaries and phone controls.
- Console/GPU checks and actual canvas pixels are checked; submitted triangles alone are not treated as visual acceptance.
- No email was sent or queued by the preview checks. No unit/Jest suites or hooks were run.

Remaining limits: local preview only, simplified navigation collision, adapted live lighting/procedural materials, and browser viewport checks rather than physical-phone acceptance. Other species share their extracted mesh across finish treatments; no user photo generates a model.

## Sites migration review (31 October 2026)

Baseline: `e8bf76d` (authenticated image helper). Fresh parallel Standards and Spec reviews covered the main migration and its new source files. Both focused follow-ups report no remaining blocker.

Standards findings closed: preserve the user's HOME environment in the supplied setup scripts; remove the unused duplicate auth module. Spec findings closed: bind accepted member roles to stable Sites IDs and enforce the 250-photo cap atomically. The built-in Codex review identified request-driven mail retry and ZIP64 export gaps; those are fixed and covered by the isolated provider and HTTP/Python export journeys.

Validation performed without unit/Jest suites or application test hooks: typecheck, production build, Worker/D1/R2 HTTP integration, local provider boundary, real Chrome browser forms and phone layouts, park planting/navigation, and 3D geometry/camera/collision checks. The image helper has separate live endpoint evidence. Browser identity fixtures do not prove hosted ChatGPT sign-in; hosted publication is tracked separately by Sites. Physical phone hardware, real email delivery and a maximum-size 250-photo export load remain unverified.

The final built-in focused review reports no unresolved actionable finding after the verified attachment/delete race was fixed. Custom migration `0002_media_integrity.sql` prevents dangling/cross-memorial photo references and invalid published portraits. A real HTTP race verifies one winner and clean parent deletion. Ordinary memory edit/review writes also compare current status, so a concurrent keeper action cannot undo moderator hiding.
