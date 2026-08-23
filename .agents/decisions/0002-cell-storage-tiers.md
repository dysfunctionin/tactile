# 0002: Cell storage tiers

- Status: accepted
- Date: 2026-08-24
- Owners: unassigned

## Context

Cells were persisted one record per cell and loaded whole. A 250k-cell import issued roughly 500k discrete IndexedDB requests and took ~72s to become durable, and every workspace was held complete in JavaScript memory, so RAM scaled with workspace size rather than with what the user was looking at.

Per-request overhead dominated, not bandwidth: there are no secondary indexes on the record stores, so the cost was structured clone, array-key encoding, B-tree insert, and event dispatch, ~290us per cell.

## Decision

A fixed 64 x 64 block of cells is the unit of storage and of caching, shared by every backend (`src/core/dataset/cellChunks.js`). The same 64-row block already backs aggregate summaries in `SheetSnapshotDatasetStore`, so storage and aggregation partition identically.

Tiering:

- Backing store is whichever tier holds the whole workspace: native SQLite/WAL through Rust, IndexedDB `cellChunks` in the browser. The browser keeps IndexedDB rather than shipping WASM SQLite.
- Cache is a bounded set of chunks in RAM. Above a cell-count threshold a sheet becomes `storageMode: "virtual"` and only cached chunks are resident; below it a sheet stays `"eager"` and fully resident.
- Portable JSON stays the recovery authority on native. SQLite is a rebuildable working store, never the only copy.

Under `"virtual"`, a cell that is not resident renders its last known value dimmed rather than blank, and a formula awaiting a pushed-down aggregate holds its previous value until the new one lands.

Workspace identity is not patchable. A transition that changes `workspace.id` writes a full snapshot and re-anchors the active pointer, because patching would file the new workspace under the previous id.

## Consequences

- Cell writes cost one read-modify-write per touched block instead of one per cell. The 250k-cell import writes 82 records and is durable in ~3.4s.
- `workspace.objects[id].cells` stops being a complete map for virtual sheets. Every reader of it must tolerate absence; aggregates over uncached ranges are pushed down to the backing store instead of scanning in JavaScript.
- Two resident-state paths exist by design. The threshold keeps small sheets synchronous and debuggable, at the cost of both paths needing coverage.
- Native and web diverge in measured performance on purpose. Suites must attribute results to a runtime rather than averaging them.

## Validation and rollback

Browser records v2 adds `cellChunks` and leaves the v1 `cells` store readable; a workspace migrates on first open through `migrateCellChunks`, since v1 shipped in 37 tags and cannot be dropped. Rollback is per-workspace: the v1 store is only deleted once its chunks are written.

Chunk layout, key ranges, and migration are covered in `tests/cases/platform/browser-persistence.test.mjs`; identity re-anchoring in `tests/cases/core/shadow-transition.test.mjs`; restore-after-reload at size in `tests/cases/e2e/large-sheet-interactions.e2e.spec.mjs`.
