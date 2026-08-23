# Core subtree instructions

These rules apply under `src/core/` in addition to root guidance.

- This subtree is headless. Do not import React, DOM globals, or `src/ui/`.
- Reach persistence, IPC, and runtime detection through `src/platform/`, never directly.
- `*.ts` files here are typed contracts over the runtime `*.js` implementations; change both sides together.
- Keep sheets sparse and virtualized; avoid work proportional to the full grid.
- Cells persist and cache as 64 x 64 chunks (`dataset/cellChunks.js`); keep every backend on that layout.
- A virtual sheet's `object.cells` is partial, so treat a missing cell as not-yet-loaded, never as empty.
- Preserve stable object/link IDs, containment/alias semantics, and unknown-field round-tripping.
- Portable workspace v4 is a compatibility contract; private caches stay rebuildable.

Validate with the matching `tests/unit/<area>/` file first, then `npm run typecheck`.
