# 0002: Tab-scoped browser workspaces

- Status: accepted
- Date: 2026-08-24
- Owners: unassigned

## Context

Browser workspaces can exceed the small synchronous `localStorage` quota, while users expect a reload to preserve work without making a browser import durable forever. Sharing one active IndexedDB workspace across tabs also lets tabs overwrite one another. Native workspaces have a different authority: the user-selected folder remains durable until changed in Settings.

## Decision

Each top-level browser tab owns one ephemeral workspace session. A random session ID lives in `sessionStorage`; its full workspace lives in a dedicated IndexedDB database. Reload reuses the session ID and database. A new tab creates a new ID and starts blank, including tabs opened in the same browser context.

The blank startup workspace is a render seed, not browser authority. Hydration from the tab database must preserve reload navigation state. User-driven import publishes the replacement to React after durable snapshot replacement completes; the generic patch reconciler must not process that same replacement a second time.

Reload navigation is a compact, versioned intent containing the tab workspace ID, navigation root, ordered stable link IDs, and leaf mode. Capture it before the blank render seed can validate or rewrite history, then resolve it once the authoritative tab workspace hydrates. The complete link path remains logical breadcrumb/back-navigation state, while source geometry, viewport snapshots, and animation phases are ephemeral; direct reload renders only the active parent and leaf without replaying hidden ancestors.

Dense sheet cells are stored in bounded 32 x 32 spatial chunks rather than one IndexedDB record per cell. Snapshot import and structural sheet replacement therefore issue hundreds of chunk writes instead of hundreds of thousands of cell writes. Forward patches update only affected chunks. Opening a version-1 per-cell workspace atomically rewrites it in version-2 chunks; this private schema does not change portable workspace v4.

Browser sessions publish only lifecycle metadata to a small `localStorage` registry. A dirty session registers the browser's generic `beforeunload` confirmation; successfully exporting clears that close protection. Closed sessions are discardable and are not offered for recovery.

A new blank tab cleans retired session databases and legacy recovery records. Heartbeats and a `BroadcastChannel` liveness probe exclude active tabs from destructive cleanup, and recent active leases are retained when liveness cannot be established. Blocked IndexedDB deletions remain registered so a later blank tab can retry them.

Native startup and persistence remain folder-scoped. The configured workspace path is authoritative and may be changed in Settings.

## Consequences

- Large browser imports survive reload without depending on `localStorage` capacity.
- Large imports and dense structural edits avoid per-cell IndexedDB request overhead.
- Concurrent tabs cannot read or overwrite one another's active workspaces.
- Browser data is ephemeral by product contract and closed workspaces are not recoverable. Data may remain physically present until a later cleanup pass because browsers cannot guarantee asynchronous IndexedDB deletion during shutdown.
- Close protection uses browser-provided text. Custom close dialogs and automatic asynchronous export during shutdown are unsupported.
- Browser sessions do not automatically migrate the previous global browser workspace.
- Portable exports remain the durable user-owned browser artifact.

## Validation and rollback

Platform tests cover session identity, reload reuse, copied-session collision, close outcomes, live-tab and lease cleanup exclusions, legacy-record deletion, blocked deletion retries, chunked snapshot round trips, and patch persistence. Playwright scenarios cover same-tab reload, fresh-tab blank state, concurrent isolation, export prompting, large import, and dense structural edits. Native persistence tests guard the folder-authority path.

Rollback removes session-specific database selection; do not restore the full-workspace `localStorage` cache as browser authority.
