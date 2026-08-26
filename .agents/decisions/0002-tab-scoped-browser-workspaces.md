# 0002: Tab-scoped browser workspaces

- Status: accepted
- Date: 2026-08-24
- Updated: 2026-08-26
- Owners: unassigned

## Context

Browser workspaces can exceed the small synchronous `localStorage` quota, while users expect a reload to preserve work without making a browser import durable forever. Sharing one active IndexedDB workspace across tabs also lets tabs overwrite one another. Native workspaces have a different authority: the user-selected folder remains durable until changed in Settings.

## Decision

Each top-level browser tab owns one ephemeral workspace session. A random session ID lives in `sessionStorage`; its full workspace lives in a dedicated IndexedDB database. Reload reuses the session ID and database. A new tab creates a new ID and starts blank, including tabs opened in the same browser context.

The blank startup workspace is a render seed, not browser authority. Hydration from the tab database must preserve reload navigation state. User-driven import publishes the replacement to React after durable snapshot replacement completes; the generic patch reconciler must not process that same replacement a second time.

Reload navigation is a compact, versioned intent containing the tab workspace ID, navigation root, ordered stable link IDs, and leaf mode. Capture it before the blank render seed can validate or rewrite history, then resolve it once the authoritative tab workspace hydrates. The complete link path remains logical breadcrumb/back-navigation state, while source geometry, viewport snapshots, and animation phases are ephemeral; direct reload renders only the active parent and leaf without replaying hidden ancestors.

Dense sheet cells are stored in bounded 32 x 32 spatial chunks rather than one IndexedDB record per cell. Snapshot import and structural sheet replacement therefore issue hundreds of chunk writes instead of hundreds of thousands of cell writes. Forward patches update only affected chunks. Opening a version-1 per-cell workspace atomically rewrites it in version-2 chunks; this private schema does not change portable workspace v4.

Browser sessions publish only lifecycle metadata to a small `localStorage` registry: session/database ownership, workspace ID and name, and last-change/export timestamps. Workspace contents remain in the session's IndexedDB database. A dirty session registers the browser's generic `beforeunload` confirmation; successfully exporting records the export timestamp and clears that close protection without mutating portable workspace data.

Closing a dirty tab marks its session as an orphan; closing a clean tab makes it disposable. A new blank tab also converts expired dirty sessions into orphans, covering crashes where `pagehide` did not run. Heartbeats and a `BroadcastChannel` liveness probe exclude active tabs from recovery and destructive cleanup, and recent active leases are retained when liveness cannot be established.

Restore adopts the orphan's existing session ID and IndexedDB database, then reloads the current tab so normal browser hydration reads that database. It does not copy or deserialize the workspace into the fresh tab database. If the current tab is dirty, restore first preserves it as another orphan; a clean displaced session becomes disposable. Claims and discards are serialized with the Web Locks API when available and revalidated against current registry ownership. An interrupted claim returns to orphan status after its lease expires.

Users may discard one orphan or confirm discarding all. Successful discard deletes the orphan database and registry entry. Blocked IndexedDB deletions remain registered for retry; recoverable dirty sessions are never removed by routine cleanup.

Native startup and persistence remain folder-scoped. The configured workspace path is authoritative and may be changed in Settings.

## Consequences

- Large browser imports survive reload without depending on `localStorage` capacity.
- Large imports and dense structural edits avoid per-cell IndexedDB request overhead.
- Concurrent tabs cannot read or overwrite one another's active workspaces.
- Dirty closed browser workspaces are recoverable until restored, explicitly discarded, or removed by browser/site-data controls. Clean closed workspaces remain ephemeral cleanup candidates.
- Close protection uses browser-provided text. Custom close dialogs and automatic asynchronous export during shutdown are unsupported.
- Browser sessions do not automatically migrate the previous global browser workspace.
- Recovery timestamps and orphan state are browser-private metadata and do not change portable workspace v4.
- Portable exports remain the durable user-owned browser artifact; orphan recovery is a convenience, not a backup guarantee.

## Validation and rollback

Platform tests cover session identity, reload reuse, copied-session collision, dirty/clean close outcomes, timestamp ordering, stale-session orphaning, live-tab and lease exclusions, exclusive restore claims, dirty-current preservation, partial discard failure, legacy-record deletion, blocked deletion retries, chunked snapshot round trips, and patch persistence. Playwright scenarios cover same-tab reload, fresh-tab blank state, concurrent isolation, export prompting, real IndexedDB restoration, restoration UI, confirmed bulk discard, large import, and dense structural edits. Native persistence tests guard the folder-authority path.

Rollback removes session-specific database selection; do not restore the full-workspace `localStorage` cache as browser authority.
