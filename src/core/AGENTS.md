# Core subtree instructions

These rules apply under `src/core/` in addition to root guidance.

- This subtree is headless. Do not import React, DOM globals, or `src/ui/`.
- Reach persistence, IPC, and runtime detection through `src/platform/`, never directly.
- `*.ts` files here are typed contracts over the runtime `*.js` implementations; change both sides together.
- Keep sheets sparse and virtualized; avoid work proportional to the full grid.
- Cells persist and cache as 64 x 64 chunks (`dataset/cellChunks.js`); keep every backend on that layout.
- A virtual sheet's `object.cells` is partial, so treat a missing cell as not-yet-loaded, never as empty.
- Residency lives in `dataset/chunkCache.js` and `dataset/virtualSheet.js`. Invalidation marks a block stale and keeps its values; only a failed read drops one.
- `dataset/storageMode.js` picks eager or virtual per sheet from stored cell count, and never sends a virtual sheet back to eager.
- Do not add a range scan to `dataset/virtualSheetStore.js`. Scanning makes every block resident, which is what the virtual mode exists to avoid.
- Anything that serializes a workspace goes through `dataset/hydrate.js` first, or a virtual sheet writes out only the blocks that were on screen.
- `dataset/sheetIndex.js` keeps embedded and formula cells known while the rest of a sheet is absent. Derive it from the blocks; a copy maintained on the side drifts from what is stored.
- Never rewrite a sheet's stored blocks from `object.cells` without checking `canRewriteCells`. A partial sheet holds a floor, and rewriting from it deletes everything else. The mark is a plain field, not a symbol: the engine and the patch layer clone records with `structuredClone`, which drops symbol keys.
- Row and column insert/delete shift cells by one, which is not a block-aligned move: the edge row of each block crosses into its neighbour. `dataset/shiftChunks.js` rewrites the stored blocks a band at a time; never rekey blocks instead.
- A partial sheet's structural edit emits a `shift-cells` patch operation. Persistence applies it before opening its record transaction, because a band walk cannot happen inside one.
- `dataset/*.js` must not import `dataset/*.ts`; the node test harness loads these files with no TypeScript loader.
- Preserve stable object/link IDs, containment/alias semantics, and unknown-field round-tripping.
- Portable workspace v4 is a compatibility contract; private caches stay rebuildable.

Validate with the matching `tests/unit/<area>/` file first, then `npm run typecheck`.
