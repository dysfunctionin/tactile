# Application domain

Owns the React shell, object model/registry, navigation, commands, browser persistence, portable import/export, sheets, Markdown, themes, and workers.

Layout: `src/app/` composes, `src/core/` holds headless domain logic, `src/ui/` holds React, `src/platform/` holds adapters.

- Keep shell responsibilities separate from object-specific behavior.
- Keep `src/core/` free of React; keep persistence and IPC details inside `src/platform/`.
- Use the existing registry, command, topology, and persistence boundaries.
- Preserve stable object/link IDs, containment/alias semantics, deterministic repair, and unknown fields.
- Treat portable workspace v4 as a compatibility contract; private caches are rebuildable.
- Keep sheets sparse and virtualized; avoid work proportional to the full visible grid.
- Heavy Markdown renderers remain lazy, strict, and source-only at the portable boundary.

Load `knowledge/architecture.md` for cross-module changes and `knowledge/file-format.md` only for serialized data or migration work.
