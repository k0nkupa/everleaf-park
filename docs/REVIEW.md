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
