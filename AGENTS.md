# Tactile agent entrypoint

Tactile is a React/Vite local-first workspace with a Tauri/Rust native shell and independently compiled marketplace plugins.

## Route first

1. Read `.agents/routing.md` and classify the task.
2. Load one relevant workflow and one primary domain file.
3. Load the nearest local `AGENTS.md` only when working in that subtree.
4. Inspect the owning source, callers, and nearest tests before editing.
5. Load knowledge or decisions only when the change crosses a durable boundary.

Do not scan all Markdown, source, tests, or history. Expand context one concrete dependency at a time.

## Code map

Resolve ownership here before searching.

| Path            | Owns                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| `src/app/`      | Entry point and composition root                                       |
| `src/core/`     | Headless domain: engine, sheet math, workspace, compatibility, workers |
| `src/ui/`       | React components, object renderers, shell, styles                      |
| `src/platform/` | Browser, Tauri, and code-runtime adapters                              |
| `src-tauri/`    | Rust shell, native persistence, packaging                              |
| `marketplace/`  | Plugin packages, host SDK, generated catalog                           |
| `tests/`        | `unit/` runs by default; every other suite is explicit                 |
| `scripts/`      | Build, marketplace, and release automation                             |

Headless logic belongs in `src/core/`; React belongs in `src/ui/`. Choose the folder before loading callers.

## Precedence

Explicit user requirements override repository guidance. Within the repository, the nearest applicable `AGENTS.md` overrides this file; selected workflow/domain guidance overrides general guidance. Source and executable tests are authoritative for current behavior. If guidance is stale, fix it with the implementation.

## Repository rules

- Routine work starts from `alpha`; `main` is production-only.
- Preserve unrelated worktree changes and keep edits scoped.
- Prefer existing boundaries and focused tests over new abstractions.
- Edit only `version.json` for app versions; synchronize generated mirrors.
- Never move a published tag or commit official binaries/build outputs.
- Validate the touched slice immediately after the first edit, then broaden before handoff.

If routing remains ambiguous after a targeted search, ask one focused question instead of loading the repository broadly.
