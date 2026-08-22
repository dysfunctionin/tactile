# 09 — File sidebar open

## Current time
**Not benchmarked** — the suite has no scenario for opening the Files panel. It felt slow in the
trial run, so this file records the plan and a measurement so it can be gated like everything else.

Proposed measurement: a scenario that opens the file sidebar (`shell.toggleFiles`) on the fixture
workspace and times index-build + first paint. Expected current: on the high fixture, index build is
O(objects) — small, but the **lazy chunk load + full tree render + main-layer resize** overlap.

## Why it is slow (code-causation read)
0. **Interplay with the commit cascade**: opening the sidebar right after an edit mounts the panel
   while the 1.4 s engine `applyChanges` + ~2.6 s differential + 0.18 s cache flush from that last
   commit are still draining on the main thread (`10-single-edit-latency.md`). The panel *appears*
   slow even though its own work is small. Fixing the commit path (11/10) is part of the fix here.
1. **Files index rebuilds on every workspace change**: `buildFilesIndex(workspace, previousIndex)`
   runs in a `useMemo` at the App level (`src/App.jsx:98-100`). When `TOPOLOGY_REVISION` changed it
   runs `repairObjectTopology(objects)` — the same topology repair that the persistence path runs —
   then builds+sort+`normalizeSearchText` for every object (`src/shell/filesIndex.js:100-270`).
   For a workspace that was just edited, opening the sidebar re-renders with a meanwhile-stale memo,
   so the open itself can appear to pay the index rebuild.
2. **First open loads the lazy `FilesPanel` chunk** through Suspense with a fallback shell
   (`App.jsx:24,705-711`) — one chunk parse + tree mount of every file row (icon, title, path labels).
3. **Main layer is made `inert` and resized** (`--files-sidebar-width`), forcing a full re-layout of
   the visible sheet while the panel mounts; on the high fixture that re-layout overlaps cell paints.

## Plan
- **P0** Add a `files-open` scenario to the suite (open sidebar → first panel paint → close), so
  current time is measured and gated.
- **P2.6** Incremental files index keyed by topology revision + object set (skip rebuild when
  nothing object-relevant changed; reuse `entryByObjectId`, apply deltas rather than rebuild).
- **P5** Preload the `FilesPanel` chunk after first idle; mount the tree in idle-time slices for
  large object counts and virtualize deep trees.
- **P2.4** Avoid full main-layer relayout on open by animating the width via transform/`contain`
  or deferring cell paints until the sidebar width settles.
- **P3/P4** Index and sidebar never clone the workspace (they already don't — keep it that way).

## Expected time
- Open-to-first-paint: **< 50 ms** regardless of workspace size; index rebuild on a 1k-object
  workspace **< 15 ms**; no main-thread stall > 50 ms during open.

## Gate
New `files-open` suite scenario; pass if open-to-paint < 50 ms and max main-thread stall < 50 ms on
both profiles.