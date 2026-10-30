# Playable preview scope

Use Tony's nine supplied Blender scenes in `/Users/tony/Downloads/everleaf_blender/`. Do not use the older concept models. Preserve the village and all six theme/setting combinations. Users must move through the actual 3D village, create and save a memorial, see its stable location and enter its house or garden. Keyboard, pointer and phone controls must work. Existing photos, memories, candles, private drafts and visibility rules remain connected to the same saved records.

Run a separate loopback-only preview with email disabled and isolated persistent data. Local preview access must not become a public authentication bypass. Preserve the configured Resend credentials without using them. No deployment, real email, unit/Jest suites or hooks.

Export source copies without saving over the supplied Blender files. Convert metaballs and text; retain replaceable portrait surfaces and sculptures; merge static objects to reduce browser draw calls. Procedural grain is simplified to its material palette for this first live 3D preview. Both dog shapes are supplied separately; other species come from the supplied village and share their extracted shape across finish treatments. No uploaded photo generates a likeness.

Acceptance: actual Chrome WebGL rendering and camera movement, collision boundaries, mouse/touch input, saved memorial appearing at a stable plot after reload, entering house and garden, all six environments loaded, visible selected sculpture, private/public boundaries, readable fallback and no email requirement.

Review baseline: `9f4a1c0`, the completed local website before the 3D work. Existing package changes adding Three.js are part of this preview.

Implementation: the village uses an orbitable overhead camera; memorials use a walking camera with drag-to-look. GLB models use meshopt compression with full geometry retained. The browser gate checks rendered canvas pixels and actual WebGL error state, in addition to saved-data/API readbacks. Source hashes are retained in scene manifests.
