# 0002: Tab-scoped browser workspaces

- Status: accepted
- Date: 2026-08-24
- Owners: unassigned

## Context

Browser workspaces can exceed the small synchronous `localStorage` quota, while users expect a reload to preserve work without making a browser import durable forever. Sharing one active IndexedDB workspace across tabs also lets tabs overwrite one another. Native workspaces have a different authority: the user-selected folder remains durable until changed in Settings.

## Decision

Each top-level browser tab owns one ephemeral workspace session. A random session ID lives in `sessionStorage`; its full workspace lives in a dedicated IndexedDB database. Reload reuses the session ID and database. A new tab creates a new ID and starts blank, including tabs opened in the same browser context.

Browser sessions publish only lifecycle metadata to a small `localStorage` registry. Heartbeats and a `BroadcastChannel` liveness probe exclude active tabs from recovery. A dirty session registers the browser's generic `beforeunload` confirmation. Confirmed close, unanswered close, crash, or force-close makes the session recoverable after its ownership signal and handoff grace expire. Recovery is discovered only when a new blank tab starts; existing work tabs are never interrupted.

Recovery offers Restore tabs, Export all, Discard, or dismissal to continue blank. Restore claims every orphan atomically, adopts one in the current tab, and opens one tab per remaining session with one-time tokens. Failed popup opens and failed exports remain recoverable. Blank or successfully exported sessions need no warning and may be deleted after close.

Native startup and persistence remain folder-scoped. The configured workspace path is authoritative and may be changed in Settings.

## Consequences

- Large browser imports survive reload without depending on `localStorage` capacity.
- Concurrent tabs cannot read or overwrite one another's active workspaces.
- Browser data is ephemeral by product contract but may remain physically present until a later cleanup pass; browsers cannot guarantee asynchronous IndexedDB deletion during shutdown.
- Close protection uses browser-provided text. Custom close dialogs and automatic asynchronous export during shutdown are unsupported.
- Browser sessions do not automatically migrate the previous global browser workspace.
- Portable exports remain the durable user-owned browser artifact.

## Validation and rollback

Platform tests cover session identity, reload reuse, copied-session collision, close outcomes, crash expiry, restore claims, and popup-block release. Playwright scenarios cover same-tab reload, fresh-tab blank state, concurrent isolation, export prompting, live-tab exclusion, orphan discovery, and multi-tab restore. Native persistence tests guard the folder-authority path.

Rollback removes session-specific database selection and recovery UI together; do not restore the full-workspace `localStorage` cache as browser authority.
