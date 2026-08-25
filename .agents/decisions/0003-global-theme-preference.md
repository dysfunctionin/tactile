# 0003: Global theme preference

- Status: accepted
- Date: 2026-08-25
- Owners: unassigned

## Context

Portable workspaces carry `activeThemeId` and custom theme records, but users treat the selected application theme as an appearance preference rather than workspace content. Using each workspace's active theme makes web tabs disagree and lets changing a native workspace folder unexpectedly change the whole application's appearance.

## Decision

The selected theme is an app-global preference in both web and native runtimes. Web builds store it in local storage under `tactile.theme-preference.v1`, where it survives browser restarts and synchronizes live tabs through the `storage` event.

Native builds store a versioned record in Tauri's per-user app-config directory as `preferences.json`. Native startup reads that file before mounting React and mirrors its theme into WebView local storage only as a first-paint cache. When the file does not exist, startup migrates the previous `tactile.theme-preference.v1` value once. The explicit file remains authoritative after migration and when a native workspace path changes.

The preference stores the selected ID and startup color scheme. A selected custom theme also carries a normalized snapshot so another tab or workspace can render it without owning that workspace's theme record. Built-in themes continue to resolve from the current application catalog. When no global preference exists, the first hydrated workspace seeds it.

Portable `activeThemeId` and theme records remain supported workspace data. Native selections continue updating the active workspace for compatibility, but loading another workspace cannot override an existing global preference. Browser-only appearance changes do not dirty an otherwise untouched blank workspace.

Native app-data cleanup is an explicit in-app flow because macOS app bundles and Linux package managers do not provide a consistent interactive uninstaller. Cleanup waits for Tactile to exit before deleting Tactile-managed config, data, cache, logs, databases, and WebView data. Users choose whether to restore only `preferences.json` or delete all app-managed data. User-selected workspace folders are never cleanup targets.

## Consequences

- Web tabs and web restarts share one selected appearance; native workspace paths share the native profile appearance.
- Startup uses the stored light or dark color scheme before React loads.
- Custom theme selection is portable across tabs and workspace switches as a preference snapshot; editing or deleting the selected custom theme updates that snapshot.
- Importing a workspace does not implicitly replace an established application appearance preference.
- Reinstalling a native build with the same application identifier retains preferences when the app-config directory remains present.
- Changing the application identifier requires an explicit profile migration.

## Validation and rollback

Platform tests cover built-in and custom browser/native preference storage, typed native IPC payloads, and malformed-data fallback. Rust tests cover the versioned file contract, custom-theme validation, and cleanup path guards. Playwright covers live-tab synchronization, clean blank sessions, startup color, and reopening after all tabs close, while the existing theme scenario guards resolved visual tokens.

Rollback removes the native file commands, migration, global preference override, and startup read together, returning selection authority to each workspace's `activeThemeId`.
