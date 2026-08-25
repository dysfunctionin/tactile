# UI subtree instructions

These rules apply under `src/ui/` in addition to root guidance.

- Presentation only. Domain rules, serialization, and topology belong in `src/core/`.
- Do not call persistence or Tauri APIs directly; go through `src/platform/`.
- Object renderers use the registry contract in `objects/registry/`; built-ins and plugins share it.
- Keep heavy Markdown and diagram renderers lazy.
- Plugin-specific selectors never enter `styles/styles.css`; packages own their CSS.

Validate rendered behavior with `tests/e2e/`; validate pure projections with `tests/unit/`.
