# Everleaf Park v2 assets (drop-in)

Put Garmin's GLBs here and list them in `manifest.json`. Any key that is missing falls back to the placeholder geometry in `src/park-assets.ts`.

Keys:
- `park`: the park village. It should contain empties named `plot_00` … `plot_47`. Their world positions replace the default grid.
- `stone_classic`, `stone_arch`, `stone_heart`, `stone_leaf`: gravestones. Put the origin at the base centre with the front facing +Z, and include an empty named `text_anchor` on the front face. The carved name plate is parented to that empty; an optional `userData.width` sets the plate width in metres.
- `plot_base`: the dirt bed under each stone, about 2.5 m across.
- `candle` (an optional child mesh named `flame` flickers), `flowers`, `toy`.
- `pet_<species>`, optional: `dog`, `cat`, `rabbit`, `bird`, `guinea`, `horse`, `turtle`. Without these, the existing `/models/pet_*.glb` files are used.

Example: `{ "park": "park_village.glb", "stone_classic": "stone_classic.glb" }`
