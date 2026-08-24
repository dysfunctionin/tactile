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
- `dataset/*.js` must not import `dataset/*.ts`; the node test harness loads these files with no TypeScript loader.
- Preserve stable object/link IDs, containment/alias semantics, and unknown-field round-tripping.
- Portable workspace v4 is a compatibility contract; private caches stay rebuildable.

Validate with the matching `tests/unit/<area>/` file first, then `npm run typecheck`.
