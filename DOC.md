# Tactile — Technical & Performance Reference (DOC.md)

> Purpose: single reference for how Tactile works internally and where time goes,
> written as the baseline for an upcoming performance-optimization effort.
> Every claim traces to source files (paths given). Full raw research notes live in
> `.progress/raw/<session>/report.md` (7 deep-dive reports, captured 2026-08-22).
>
> ⚠ Performance notes are marked **[PERF]**. The ranked fix list is §17.

---

## 1. What Tactile is

Local-first spatial workspace: a canvas ("root layer") holding **objects**
(sheets, markdown documents, links, marketplace plugins). Objects can nest
("embedded"/child objects) and be aliased. Sheets are sparse spreadsheets with
formulas, formatting, conditional formatting, filters/sorts. Everything is stored
in inspectable formats (JSON workspace + CSV sheets + Markdown + media files);
no account/cloud required. Runs in browser (dev) or Tauri desktop shell (Win/mac/Linux).

## 2. Tech stack

| Layer | Tech |
|---|---|
| UI | React **19.2.0** (JSX), plain JS mostly (`src/core/**` and `src/platform/tauri/**` are TypeScript) |
| Build | Vite 6 (`vite.config.mjs`), esbuild (marketplace plugin bundles), Node **24.13.0**, npm **11.6.2** |
| Desktop | Tauri **2.x**, Rust stable (`rust-toolchain.toml`), tauri-plugin-updater |
| Editors | CodeMirror 6 packages (used inside Code plugin bundle) |
| Heavy libs (lazy) | katex 0.16 (math), mermaid 11 (diagrams), pdfjs-dist 4 (PDF plugin), jszip (import/export), sucrase (runtime TS/JSX transpile **inside Code plugin only**) |
| Fonts | `@fontsource-variable/lilex`, `@fontsource-variable/public-sans` |
| Icons | @tabler/icons-react |
| Tests | node:test unit, Playwright component+e2e, c8 coverage, custom browser perf bench |

State management: **no Redux/Zustand**. One React `useState` holding the whole
workspace object (see §4), plus a parallel "Wave 2" normalized store used for
patch-based persistence. Web Workers for formula recalculation.

## 3. Repository map (runtime-relevant)

```
src/
  main.jsx                 entry: parses cached workspace JSON at MODULE SCOPE (theme pick)
  App.jsx                  god component: workspace state wiring, layers, native sync effect
  storage.js               localStorage cache + legacy IndexedDB (v3) read/write
  model.js                 WORKSPACE_VERSION=4, normalizeWorkspace, topology repair hooks
  export.js                buildPortablePackage (v4 zip layout), CSV serialization glue
  themes.js, styles.css    theming (CSS vars), all styling
  hooks/useLocalWorkspace.js  THE state hook: load/save/commit/history/shadow reconcile
  core/
    model.ts domain.ts     normalized entity model (workspace/objects/cells/assets/themes)
    commands/execute.ts    command execution → TransactionMutationBuilder ops
    engine/{normalizedStore,transactionEngine,shadow,legacyAdapter,clone,hooks}
    history/{patchHistory,patches}.ts   forward/inverse patch stacks (limit 120)
    topology.js reparenting.js  containment/alias repair (O(cells·log cells))
    persistence.ts         PersistencePort interface (browser + tauri implementations)
  platform/
    browser/{persistence,indexedDb,records,migration,bootMetadata,assets}  records-IDB adapter
    tauri/{runtime,contracts,persistence,dialogs,factory,updater}          typed port (mostly dead)
  sheet/                   formulas.js (engine), ranges.js, structure.js, sort.js,
                           textMeasure.js, formatting.js, conditionalFormatting.js
  workers/formula/         worker.js runtime.js client.js protocol.js
  objects/
    registry/              builtin+plugin registry, ObjectPluginProvider, marketplace loader
    sheet/                 SheetObject/SheetGrid/SheetCell + grid/ (canvas, gestures, projection)
    markdown/              custom parser/renderer, mermaid/katex capabilities
    link/                  LinkObject
  components/              FormulaBar, FilesPanel, SettingsPanel, TitleBar, StartupLoader…
  shell/                   inOut.js (import/export/layers), selectionCommands.js,
                           filesIndex.js, workspaceCommands.js
marketplace/               independently-built optional plugins + generated catalog.json
src-tauri/                 Rust shell: lib.rs commands, storage/sqlite.rs (dead), updater
scripts/build-marketplace.mjs, check-bundle-budget.mjs, release/*
tests/                     unit, compatibility, performance (bench runner), visual, e2e specs
config/playwright/         component.config.mjs, e2e.config.mjs
evidence/performance/      retained benchmark evidence + baseline-results.json
perf-dashboard/            prebuilt static dashboard (source absent from repo)
```

## 4. State architecture — three generations coexist

1. **Legacy (authoritative at runtime)**: `useLocalWorkspace` keeps the entire
   workspace as one immutable-by-convention JS object in React state. Mutations
   produce new wrapper objects; the sheet `cells` dict is deliberately mutated
   in place during cell commits so a WeakMap change-journal stays valid.
2. **Wave 2 shadow engine**: every workspace change is diffed by
   `core/engine/shadow.js#reconcile`, converted to commands for a normalized
   store (`NormalizedWorkspaceEngine`), producing forward patches that feed
   records-IDB persistence. Engine selector subscriptions exist
   (`core/engine/hooks.ts`) but **no app code consumes them** (tests only).
3. **Persistence ports** (`core/persistence.ts`): `BrowserPersistenceAdapter`
   (live) and `TauriPersistencePort` (typed delta protocol over IPC — **dead**,
   its commands were never registered in Rust; see §5.6).

Runtime truth = legacy useState. The shadow store exists to generate deltas +
verify equivalence (`compareEngineSnapshots` normalizes BOTH sides per edit).

Object identity: stable ids (`core/ids.ts`). Cells keyed by `cellId(row,col)` =
``r{row+1}c{col+1}`` strings in a sparse dict on each sheet object.
Containment/aliases repaired by `repairObjectTopology` (§10.5).

## 5. Persistence model (four stores, three generations)

### 5.1 Legacy localStorage cache — `src/storage.js`
- Key `tactile.workspace.v3`. `saveWorkspaceCache` runs **synchronously on EVERY
  workspace state change** (`useLocalWorkspace` effect): `JSON.stringify(whole
  workspace)` (asset binaries stripped) → `localStorage.setItem`.
  **[PERF] O(total workspace size) main-thread write per keystroke commit — the
  single worst input-path cost.** It executes even when shadow persistence is
  active (check happens after the write in the effect order).
- Load resolution: newest of (localStorage cache, legacy IDB record) by
  `updatedAt`; a selected **native folder snapshot wins if present**.

### 5.2 Legacy IndexedDB v3 — db `tactile-local-workspace` v3, store `workspaces`
- Whole workspace object incl. asset dataURLs/Blobs under key `current-v3`.
- Debounced 120 ms (`saveTimer`); skipped entirely when shadow persistence
  reports `"active"`.

### 5.3 Records DB ("Wave 2 shadow") — `src/platform/browser/*`
- db `tactile-local-workspace-records` v1; stores/keyPaths:
  `workspaceMeta[workspaceId]`, `objects[[workspaceId,objectId]]`,
  `cells[[workspaceId,objectId,cellId]]`, `assets[[workspaceId,assetId]]`
  (Blob kept on record), `themes[[workspaceId,themeId]]`.
- Boot marker: localStorage `tactile.browser.boot.v1` (≤4096 B cap).
- Writes:
  - `writeSnapshot`: ONE readwrite txn across all 5 stores; first does
    `getAll()` then deletes every row of the workspace and re-puts everything.
    **[PERF]** used for metadata-only transitions too (deleteObject forces this).
  - `commit(persisted)`: applies forward-only ops (`replace-workspace-meta`,
    `replace-object` [deletes prior cells then rewrites], `replace-cell`,
    `replace-asset`, `replace-theme`) + acknowledge — one atomic transaction.
    Deltas come from shadow engine transactions.
- **[PERF]** no secondary workspace index: reads do `getAll()` ×5 then filter in JS.

### 5.4 Native folder snapshot (live Tauri path) — App.jsx effect + Rust
- Effect keyed `[hydrated, nativeInvoke, nativeRuntime, workspace,
  workspace.settings.nativeWorkspacePath]` → **re-runs on every workspace change**.
- JS side per change: `buildPortablePackage(workspace)` (normalizeWorkspace again +
  CSV serialize every sheet + pretty-printed meta JSONs) + compact
  `JSON.stringify(workspace)` → single-flight `flush()` → IPC
  `workspace_write_snapshot`. No timer debounce; only in-flight coalescing.
- Files written per flush (all fsync'd, temp+rename each):
  `objects/<id>/sheet.csv`, `sheet.meta.json`, markdown `content.md`,
  plugin/file objects as base64 data-URL files, `themes/<id>.json`,
  `manifest.json`, then **`workspace.json` LAST = commit point**, then
  `last-workspace-path.txt` marker in app config dir.
- Rust `atomic_write` (lib.rs:79–100): deterministic temp name `<name>.tmp`,
  `sync_all()` per file, rename with single Windows fallback delete+rename
  (**non-atomic window**). No directory fsync. Identical bytes rewritten
  unconditionally — **[PERF] editing one cell in a 20-sheet workspace ≈ 40+
  fsynced writes**; `workspace_write_snapshot` is a **sync command** (blocks the
  Tauri event loop through its whole fsync chain).

### 5.5 Migration / versioning
- Portable format capped at v4 (`compat/schema.js`); validator walks every
  object/cell (limits: 10k objects, 1M cells, 100/512 MB assets).
- `migratePortableWorkspace` chains v1→v2→v3→v4, validating after each step;
  multiple `structuredClone`s per stage **[PERF]**.
- Legacy→records auto-migration inside `BrowserPersistenceAdapter.open()`:
  read legacy → normalize (full migrate) → staged snapshot → verify via
  sorted-key JSON compare + byte-for-byte assets → activate.

### 5.6 Dead persistence code (~2,600 lines compiled+tested, unreachable)
- Rust: `SqliteStorage` (WAL, synchronous=FULL; tables `tactile_meta`,
  `tactile_records`, `tactile_transactions`; journal validation/recovery),
  custom-WAL `storage::Storage`, `assets::AssetStore`, `portable::*` — none
  referenced by any registered command (`#![allow(dead_code)]`).
- TS: `TauriPersistencePort`/`contracts.ts` commands (`workspace_open`,
  `workspace_apply_delta`, `workspace_checkpoint`, …) never registered in
  `generate_handler!`; `dialogs.ts` adapter likewise unused.

## 6. Startup & loading flow

Browser/dev sequence (name → what happens):
1. `main.jsx` module scope: `JSON.parse(entire cached workspace)` to pick theme
   before React mounts **[PERF pass #1]**.
2. `initialWorkspace()`: second parse + `normalizeWorkspace` + topology repair
   during first render **[#2]**.
3. `useLocalWorkspace.loadWorkspace()`: third parse + legacy IDB get + (native)
   `workspace_get_last_path` → `workspace_read_snapshot` → parse **[#3]**.
4. Post-load settle: `normalizeWorkspace(stored)` again, then
   `createTransactionEngine(normalizeWorkspace(...))` for the shadow, then
   `structuredClone` + another normalize for `setWorkspace` **[#4–6]**.
   → **~4–6 full passes/clones before hydration settles.** StrictMode doubles
   all of it in dev.
5. Lazy mounts: `FilesPanel`, `SettingsPanel`, `TooltipLayer`,
   `NativeOnboarding` are `React.lazy`; `App` itself is lazy in main.jsx.
   JSZip imported lazily (memoized promise). Marketplace catalog fetched with
   `cache:"no-store"` at startup.
6. `StartupLoader` enforces artificial minimum durations (1000/3000 ms).

Native boot: Rust side registers only the updater plugin + handler + custom
`tactile-html` protocol; window created deferred with `decorations(false)`;
nothing blocking before webview load. All heavy work is on the JS side above.

## 7. Flow: typing in a cell (the hot path)

Per-keystroke chain while an inline editor is open:

1. Editor keystroke → local draft store (`components/localEditSession.js`).
   No model commit yet.
2. Grid's surface-draft subscription fires → `setSurfaceDrafts` + `draftTick++`
   (`grid/useSheetGridProjection.js:134–142`) → **whole SheetGrid subtree re-renders**.
3. `autoRowHeights(object, widths, drafts)` re-runs (memo invalidated by
   `draftTick`): iterates **ALL stored cells + live drafts**, canvas
   `measureText` per wrapped line — `textMeasure.js` has **no result cache** and
   rebuilds the font string per call. **[PERF]** biggest per-keystroke CPU item.
4. `buildAxisGeometry` rebuilds size/offset arrays O(visible rows+cols) because
   the merged rowHeights object literal is new each time; `visibleRows` etc.
   re-sort.
5. `SheetGridCanvas` maps every mounted slot, computing per cell BEFORE the
   memoized slot can bail: `cellDisplayText` → `formatFormulaResult` (cached
   Intl formatter) / `formatCellValue` (constructs Intl.NumberFormat inline for
   percent/number styles) / possible `projectObjectCell`; `numericRangeContains`
   ×3; `conditionalToneForCoordinates`. Slot `memo` saves DOM reconciliation,
   not these prop computations.
6. Commit (Enter/Tab/click-away): `dispatchCellEditCommitAny` →
   `useLocalWorkspace.commitCellChanges`:
   - legacy history push: cells-delta entry coalesced 650 ms (no full clone);
   - sheet `cells` dict mutated in place + fresh object/workspace wrappers;
   - embed-key patches additionally trigger `repairObjectTopology`;
   - `setState` → App-wide re-render (all layers; `renderObject` allocates ~25
     fresh inline closures per layer, defeating child memo at that boundary).
7. Effects after render:
   - `saveWorkspaceCache` sync full-stringify → localStorage (**every change**);
   - `shadow.reconcile`: diff prev/next via `JSON.stringify` record compares
     O(all cells), then engine dispatchBatch → patch → PatchHistory.push →
     dirtyRecords → records-IDB `commit()` → `refreshFormulaClients` (worker per
     sheet) → `compareEngineSnapshots(normalize(a), normalize(b))` where each
     normalize ends in topology repair **[PERF]**;
   - native path (if folder selected): full portable package rebuild + IPC flush (§5.4).

Formula-bar typing additionally sends a worker preview round-trip **per
keystroke** (`FormulaBar.jsx:128–166`, undebounced); fast typing generates
doomed requests discarded by revision guards (`client.js:92–98`).

## 8. Flow: add/delete/move row or column (+ sort)

1. Affordance/context menu → command in `useLocalWorkspace`
   (`insertSheetAxis` / `deleteSheetAxis` / `moveSheetAxis` / sort via
   `sheet/sort.js`).
2. `sheet/structure.js` (`shiftCells` / `removeSheetAxisCells` /
   `reorderSheetAxis`): **rebuilds the entire cells dict**, translating every
   formula string with a regex per formula cell.
3. History pushes a **full `structuredClone(workspace)` snapshot** (cap 120
   entries) — latency spike + memory. Only pure cell edits avoid this.
4. Axis ops replace the cells-dict identity → WeakMap journal misses →
   `fullChangesSinceLastProjection` O(cells) scan; `visibleRowIndexMap`
   recomputes O(rows × filters). Embed-touching axis ops also run topology repair.

## 9. Formula engine

Files: `sheet/formulas.js` (~37 KB), `workers/formula/*`,
`objects/sheet/grid/useFormulaProjection.js`, `cellChangeJournal.js`.

Syntax/engine facts:
- Tokenizer: regex-per-position with `source.slice(index)` substring per try →
  **O(n²) worst-case parse** **[PERF]**.
- AST cache: module-level `AST_CACHE` Map, **unbounded** (typos + every
  intermediate keystroke string accumulate; only `clearFormulaCaches()` empties).
- Dependency graph: per-cell reverse deps + range reverse index keyed **by row
  only** (column-blind rect tests); ranges >1024 rows skip indexing into
  `wideRanges` probed on EVERY dependent query. Registration expands ranges ≤100k
  cells eagerly.
- Evaluation: eager args (**IF/AND/OR never short-circuit**; errors are values so
  it's correct but not cheap); recursive `evaluateAddress` with a `stack` Set
  (deep chains risk stack overflow); BFS uses `queue.shift()` (O(n²) worst);
  `rangeValues` materializes `{values[], matrix[][]}` walking every cell through
  regex coordinate parsing + string key build.
- Number formatting: cached Intl formatters; results rounded to 1e10,
  maxFractionDigits 10.

Three duplicate engines run per edit (share nothing):
1. Main-thread projection engine per open sheet (`useFormulaProjection`):
   built inside a render-time useMemo — first mount parses ALL formulas +
   `recalculateAll()` synchronously (**opening a large sheet blocks main thread**).
   Updates are incremental via journal: WeakMap-backed 32-entry ring of changed
   ids (`JOURNAL_LIMIT=32`); overflow/out-of-band replacement falls back to
   O(cells) full diff. Values Map is mutated in place (stable identity).
2. FormulaBar preview worker: full-sheet clone once, then per-keystroke updates.
3. Shadow worker per sheet (`ensureFormulaClient`): replays same changes;
   init may ship `includeGraph:true` = serialized ENTIRE dependency graph.

Worker protocol: `init/update/dispose/result/stale`; client rejects responses
older than `latestAcceptedRevision`; runtime converts Maps→plain objects + 4
address arrays + stats per reply. Graceful degradation: no Worker ⇒ preview off,
shadow marks "unavailable", grid unaffected.

Errors surface as values (`#ERROR…` styles); parse failures fall back to
regex-based reference extraction to keep the graph safe.

## 10. Rendering internals

### 10.1 Virtualization (`useVirtualSheet.js`)
DOM-div grid (no canvas): absolutely-positioned `.virtual-cell-slot`s inside a
scroller with native sticky rails. Window computed by binary search over prefix
offset arrays (`buildVirtualRange` O(log n)/axis); overscan via
`directionalOverscan`; `syncViewport` writes 2 CSS vars per scroll frame
(rAF-batched) — cheap. Monkey-patches scrollTop/Left setters on the scroller.
Guards assert bounded mounted cells (see benchmarks §15).

### 10.2 Text measurement (`textMeasure.js`)
Singleton lazy canvas context; NO cache; per-call font-string construction.
Consumers: `autoRowHeights` (per render incl. every draft tick), autofit
commands, header fit. Fallback heuristic chars×size×0.58 without DOM.

### 10.3 Selection & gestures (`grid/useSheetGridGestures.js`, `selectionCommands.js`)
State mirrored into refs (sync reads) + React state. Drag select resolves
addresses preferring painted-DOM hit test `domCellAddressAtPoint` which calls
`getBoundingClientRect()` on **every mounted slot per pointermove** before the
pure-geometry fallback **[PERF]**. Range paint rAF-coalesced; edge auto-scroll
32 px bands ≤42 px/frame. Fill handle infers series (`ranges.js#fillChanges`),
one batched commit. Keyboard nav/clamp/copy/clear centralized in
`shell/selectionCommands.js`.

### 10.4 Display pipeline per visible cell
sparse lookup → formula projection value Map → `cellDisplayText` (embed label /
URL passthrough / formatted number) → style numberFormat (inline Intl ctor) →
compiled conditional rules (`compileConditionalRules` per sheet revision; per
cell walks rules backwards, string parse) → CSS class flags.

### 10.5 Topology (`core/topology.js`)
`repairObjectTopology` sorts every cell entry of every sheet, ranks candidate
parents, cycle-walks — O(total cells·log cells). Runs: on every load/import/
snapshot write, both sides of shadow compare, embed-touching edits, ~3× per
drag-reparent. Cached consumers key off `TOPOLOGY_REVISION`, but
`inOut.js#canonicalPathForObject` does a FULL repair per invocation uncached.

## 11. Undo / redo — two parallel histories
- Legacy (`useLocalWorkspace`): cells-delta entries (coalesced 650 ms) for cell
  commits; otherwise **full-workspace `structuredClone` snapshots**, cap 120
  → up to ~120× workspace size retained. **[PERF memory]**
- Engine (`PatchHistory`, limit 120): forward+inverse patch pairs; inverse ops
  deep-clone before+after again; merges clone yet again; asset binaries cloned
  per op. Redo stack cleared on new push.

## 12. Import / export (portable v4)
- Zip layout (`export.js#buildPortablePackage`, JSZip lazy): `workspace.json`
  (authoritative compact), per-object CSV/meta/markdown, themes, manifest.
  Assets as base64 data URLs (+33% size) **[PERF]**.
- Import: unzip → `readPortableV4Package` → validate → migrate chain if needed
  → normalize + topology repair → replaceWorkspace. Multiple deep clones per
  stage.
- Native export path can reuse the folder snapshot files; browser path builds
  the zip in memory.

## 13. Plugins / marketplace
- Builtin types registered in `objects/registry` (sheet, markdown, link).
- Catalog: `marketplace/dist/catalog.json` (schemaVersion 1); dev serves it via
  Vite middleware (80 ms-debounced rebuild + full-reload); prod fetches GitHub
  Raw with `cache:"no-store"` at startup **[PERF]**.
- Install: stream download with progress → size + SHA-256 verify (WebCrypto) →
  assets become blob URLs (`pluginAssetUrl`) → CSS injected
  `<style data-tactile-plugin>` → host global `__TACTILE_PLUGIN_HOST__`
  {React, createId, hostServices…} → dynamic `import(blobUrl)` → activate() →
  definition validated (type/packageId/version) → blob revoked.
- Trust = provenance + integrity (no sandbox). Manifest `permissions` strings
  are declarative only, unenforced.
- Code plugin bundles sucrase to transpile user TS/JSX at runtime in-browser.

## 14. Markdown object pipeline
- Custom hand-written parser (`markdownParse.js`): block pass (fences, math,
  tables, lists…) + char-by-char inline scanner trying 10 regexes per position
  via substring slicing — O(n×tokens) worst case.
- Render (`markdownRender.jsx`): blocks→React elements; no block-level memo;
  typing re-parses whole doc each keystroke (`useDeferredValue` only time-slices).
- Heavy capabilities lazy/dynamic: mermaid renderer module + katex renderToString
  synchronous on miss (LRU-ish cache 256 entries, evicts during long docs);
  find-highlight TreeWalker re-wraps matches per content change; split mode
  mounts two editors; image paste stores inline base64 in content (not assets).

## 15. Existing performance harness & budgets (use these while optimizing)

Commands:
```
npm run bench:suite           # full suite, browser target (preview server)
npm run bench:suite:native    # full suite against the REAL Tauri app
npm run bench:suite:baseline  # native, both profiles, 3 repeats → dashboard data
node tests/performance/run-browser.mjs   # legacy single-pass browser bench
```

Suite design (`benchmarks/suite/`):
- **Targets**: `--target browser` (Playwright Chromium vs preview build) or
  `--target native` (launches `src-tauri/target/release/tactile.exe` with
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<cdpPort>`,
  attaches via CDP, injects instrumentation from document start, drives the real
  app incl. native IPC/file persistence; load-warm = process start → first cell).
- **Profiles**: `low` (70 objects / 23 sheets / ~7.2k cells, 4-deep nesting) and
  `high` (the repo's deterministic 250k-tile fixture); fingerprints recorded per run.
- **Scenarios** per profile/repeat: import+first-render, scroll vertical/diagonal
  (72 frames), typing burst (24 keys), formula add (`M9` =SUM), in/out, nested,
  add-row ×8 / add-column ×8 (context-menu path), warm-cache load.
- **Consistency**: env-guard kills stray `tactile*` processes, clears
  `%TEMP%/tactile-*` + WebView2 cache for the alpha identifier, records free RAM
  before/after every scenario plus app RSS/CPU deltas (process tree or native
  process name), machine fingerprint, git commit, repeats aggregated to median/p95.
- **Outputs**: `perf-dashboard/app/public/data/runs/<runId>.json` +
  `runs.json` manifest (dashboard reads these); archived copy in
  `benchmarks/.generated/suite-runs/`.

Legacy harness (still useful):
npm run bench:perf            # tests/performance/run-browser.mjs (needs dev server up)
node tests/performance/compare-results.mjs --baseline evidence/performance/browser-results.json \
     --candidate <new.json> --tolerance 0.10 --strict   # exit 1 on regression
node benchmarks/formula-worker.mjs      # seconds; formula engine inner loop
node benchmarks/c04-virtual-window.mjs  # seconds; virtualization rebase guard
npm run build                 # bundle budget gate (CI-enforced)
```

Metrics (`window.__tactilePerf` init script): frameTime p95/max + dropped frames,
longtask observer, input latency p95 (Event Timing + keydown→rAF),
React commit counts, DOM mutation batches, mounted `.virtual-cell-slot` /
`.sheet-cell` / total nodes max, monkey-patched resource-count leak checks,
heap delta, gzip sizes of dist. Scenarios: fixture-import-and-render (250k cells),
scroll (72 frames), typing (ONE keystroke), in-out layer open/close, nested.
One measured pass per invocation (no aggregation; repeat 3× manually).

Budgets:
- Build gate (`scripts/check-bundle-budget.mjs`): entry JS ≤110 KiB gzip,
  entry CSS ≤21 KiB, katex chunk ≤80 KiB, mermaid ≤170 KiB (counts asserted).
- Release budgets (`tests/performance/measurement.mjs#RELEASE_BUDGETS`):
  frameTimeP95 16.7 ms, inputToPaintP95 50 ms, zero longtasks >50 ms,
  all-JS gzip ≤110 KiB, all-CSS ≤18 KiB (note: CSS budgets disagree 21 vs 18).
- Documented-but-unenforced (WORKFLOW.md): warm launch ≤1.5 s, cold ≤3 s,
  simple formula edit display ≤100 ms, autosave task ≤16 ms, bounded mounted
  cells, no growth after 100 nested cycles, ≤10% regression rule.

Gaps (no coverage today): app boot time, native WebView timings, burst typing
under recalc load, add-row/add-column/formula-edit scenarios in the current
runner (they existed in the retained perf-dashboard "pre-wave" run), memory
over cycles, CI automation of comparisons (compare tooling is manual-only),
dashboard source missing (only stale dist committed).

Recommended loop per optimization step:
1. micro-bench (`formula-worker.mjs` / `c04-virtual-window.mjs`) for engine/grid-math changes;
2. full bench before/after with compare-results --strict vs checked-in baseline (3 runs/side, pinned hardware);
3. npm run build for bundle-affecting changes;
4. targeted e2e specs for behavior parity (`sheet-scrolling`, `selection-drag-speed`, etc.).

## 16. Consolidated hotspot index [PERF]

| # | Hotspot | Where |
|---|---|---|
| H1 | Sync full-workspace JSON.stringify→localStorage on EVERY change | storage.js saveWorkspaceCache ← useLocalWorkspace effect |
| H2 | ~4–6 redundant parse/normalize/clone passes during boot/hydration | main.jsx, model.js, useLocalWorkspace.js |
| H3 | Per-edit shadow reconcile: JSON.stringify record diffs + double normalize/topology repair | engine/shadow.js reconcile, legacyAdapter.compareEngineSnapshots |
| H4 | Native flush rebuilds ALL CSVs+JSONs+IPC stringify per edit, sync handler fsyncs N files | App.jsx native effect, lib.rs workspace_write_snapshot |
| H5 | Legacy undo stores structuredClone(whole workspace) ×120 for non-cell ops | useLocalWorkspace cloneHistoryWorkspace |
| H6 | autoRowHeights uncached canvas measurement over ALL cells per draft tick | textMeasure.js, useSheetGridProjection |
| H7 | Parent computes per-cell props before memoized slots bail; unmemoized layer surfaces + ~25 fresh closures per layer per edit | SheetGridCanvas, App.jsx renderObject |
| H8 | Axis insert/delete/move: whole cells-dict rebuild + regex per formula + full-clone history | sheet/structure.js, useLocalWorkspace |
| H9 | Formula tokenizer O(n²); row-only range index; eager IF/AND/OR; queue.shift BFS; materialized ranges; unbounded AST_CACHE; three duplicate engines | formulas.js, workers/formula, FormulaBar preview |
| H10 | domCellAddressAtPoint getBoundingClientRect over all mounted slots per pointermove | useSheetGridGestures |
| H11 | records-IDB snapshots do getAll+delete+re-put; reads filter in JS (no workspace index) | platform/browser/persistence+indexedDb |
| H12 | Markdown whole-doc reparse/rebuild per keystroke; katex sync render on cache miss | MarkdownObject, markdownParse/Render |
| H13 | TitleBar polls window_is_maximized every 400 ms forever | TitleBar.jsx:108 |
| H14 | Global keydown handler runs document.querySelectorAll per keypress | App.jsx:172 |
| H15 | StartupLoader artificial min durations; marketplace catalog no-store fetch each boot | StartupLoader, registry/marketplace |

## 17. Optimization backlog (ranked by expected impact)

**Input latency (typing)**
1. Replace H1 with the debounced/incremental persistence paths (or write-behind
   via requestIdleCallback); gate on shadow `"active"`.
2. Cache text measurements keyed `(text,fontSize,bold)`; measure only the edited
   row on draft ticks; throttle draftTick-driven work (H6).
3. Move per-cell derived props (display text/tone/range flags) into memoized
   slots or memoize per cellId so untouched slots skip compute (H7); stabilize
   renderObject callbacks; memo ObjectSurface/ObjectRenderer/SheetObject.
4. Debounce/coalesce FormulaBar preview worker updates; reuse one pooled worker (H9).

**Structural edits**
5. Axis ops: index remap instead of full dict rebuild; cell-level undo entries
   instead of structuredClone(workspace) (H8/H5).
6. Make native flush timer-debounced + byte-diff skip unchanged files + async
   command handler; drop pretty-printing of machine mirrors (H4).

**Engine coherence**
7. Pick ONE authoritative formula evaluation path (feed worker results to grid
   OR drop shadow/preview duplication); incremental shadow diff keyed off the
   existing cell journal instead of stringify sweeps (H3/H9).
8. Fix tokenizer slicing (anchored exec, no substrings); column-aware range
   index; lazy range views; cursor-based BFS; LRU AST_CACHE; short-circuit
   IF/AND/OR (H9).

**Startup**
9. Single parse+normalize pass shared between theme pick, initial state, and
   shadow init; defer topology repair until after first paint where safe (H2);
   remove artificial loader delays; cache marketplace catalog (H15).

**Everything else**
10. Geometry-cached drag hit-testing (H10); records-IDB workspaceId indexes or
    key-range queries (H11); markdown block-content memoization + commit-based
    parsing (H12); event-based maximize tracking (H13); scope the global
    keydown querySelectorAll (H14); decide wire-or-delete for SqliteStorage/
    TauriPersistencePort (~2.6k lines dead).

---

*Generated 2026-08-22 from 7 subagent deep-dives; raw transcripts in
`.progress/raw/`. Verify against source before large refactors; line numbers
refer to the working tree at analysis time.*
