# Implementation contract

Reference: Tony's everleaf_prototype_DRAFT.zip. Preserve the three themes (Golden Hour Fête, Confetti Parade, Lantern Bloom), indoor/outdoor settings, seven species, and both sculpture/portrait approaches as clarified by Tony. The newer draft replaces the earlier art direction.

Build real local web workflows: magic-link accounts, persistent memorial drafts, validated details, private reference/public portrait uploads, appearance/theme/setting selection, arranged keepsakes, publish/visibility, public village/search/list, memory albums/contributions and approval, candles, invitations/roles/revocation, owner home/settings, reporting/moderation, archive/restore, data export and deletion. Responsive layouts and accessible non-spatial routes are required.

Use the simplest local server and SQLite persistence; preserve the original prototype. Resend is the chosen email integration. Do not create paid services, send real invitations, or deploy without applicable authorization. No external photo-to-3D provider; Tony's clarification of the photo option will be recorded here.

No unit/Jest tests, including indirect scripts/hooks. Verify type checking, actual HTTP/database/file flows, unauthorized access boundaries, and real browser journeys. Do not substitute static prototype success text for saved/read-back results.

This folder is a new dedicated Git repository because the conversation workspace had no repository. The initial import commit is the fixed point for the final two-axis code review. The user-supplied spec is this contract plus the approved draft and conversation decisions.

Tony clarified: use the existing draft sculpture collection for both stylized and naturalistic/photo-style options. Do not add a photo-to-3D service or imply that uploaded portraits generate models. Resend is selected. Its key is held only in ignored local .env.

Review refinements: co-keepers share management but cannot grant/revoke other co-keepers or permanently delete the memorial. Memory attribution is opt-in; family-only decisions restrict stories and attachments. Moderation can hide only a reported photo and reverse that action without removing the story. Archive pauses all new contributions; restore creates an unpublished draft for visibility review. Failed file deletion is retained in a durable cleanup queue and reported accurately.
