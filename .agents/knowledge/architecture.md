# Architecture knowledge

Load only for cross-module ownership, persistence, topology, or portability changes. Source and tests remain authoritative.

## Boundary map

```text
React shell
  -> command/transaction engine -> workspace model
  -> object registry -> sheet, Markdown, and file renderers
  -> persistence port
       -> browser IndexedDB adapter
       -> Tauri adapter -> typed IPC -> native cache/SQLite/WAL
  -> portable JSON/CSV/Markdown/assets
```

The shell owns workspace identity, navigation, start-object metadata, commands, themes, undo, and persistence coordination. Object renderers own type behavior. Runtime and built-in objects use the same registry contract.

## Durable invariants

- Sheets are sparse and virtualized; the 256 x 64 surface is a display default, not serialized emptiness.
- Embedded objects have stable object/link IDs, containment or alias relations, parent identity, and source cell.
- `homeObjectId` selects launch behavior; it does not rewrite containment.
- Portable workspace/object normalization is v4. Native cache schema is private and rebuildable.
- Browser/native persistence uses forward deltas and revision acknowledgements; inverse patches stay in the engine.
- Browser workspace authority is tab-scoped and ephemeral; reload restores that tab, while a new tab starts blank. See ADR 0002.
- Browser startup renders a blank seed only until its tab database hydrates. Hydration must preserve saved navigation history, while an interactive workspace replacement resets it.
- Browser IndexedDB stores dense sheet cells in bounded spatial chunks. Portable JSON remains cell-oriented, and small edits still persist through forward patches.
- Lazy object renderers keep a stable React component identity after resolution or preload so ordinary parent renders do not remount active object interactions.
- Native workspace authority remains the user-selected folder and may be changed in Settings.
- Portable files are the user recovery authority. Native SQLite/WAL is an optimization, not the only copy.
- Unknown fields and future/plugin state round-trip without coercion.

## Primary implementation

- Composition: `src/app/`, `src/ui/hooks/`, `src/ui/shell/`
- Domain/topology: `src/core/`, `src/core/workspace/model.js`
- Registry/objects: `src/ui/objects/registry/`, `src/ui/objects/`
- Browser persistence and ownership: `src/platform/browser/persistence.js`, `src/platform/browser/session.js`
- Native contracts/cache: `src/platform/tauri/`, `src-tauri/src/`
- Portable import/export: `src/core/workspace/export.js`, `src/core/compat/`, `src-tauri/src/portable/`

Create or supersede an ADR when changing a durable boundary, serialized contract, trust assumption, or recovery guarantee.
