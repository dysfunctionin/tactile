import { isTauriRuntime, resolveTauriInvoke } from "./platform/tauri/runtime.ts";
import { measureStage } from "./core/perf/stageTimer.js";

const DATABASE_NAME = "tactile-local-workspace";
const DATABASE_VERSION = 3;
const STORE_NAME = "workspaces";
const CURRENT_WORKSPACE_KEY = "current-v3";
const CACHE_KEY = "tactile.workspace.v3";
const NATIVE_WORKSPACE_PATH_KEY = "tactile.native.workspace.path";

// Write-behind state for the boot cache. Stringifying an entire large
// workspace synchronously runs on every commit, which is the single worst
// input-path cost for big fixtures. Coalescing the write onto the next
// macrotask keeps the cache fresh for boot while removing the serialization
// from the synchronous commit path.
let pendingCacheWorkspace = null;
let cacheFlushScheduled = false;
let lastCacheFlushAt = 0;
let cacheQuotaExceededFor = null;
// The boot cache is a fast-restore fallback, not a per-edit log. Coalescing the
// flush to at most once per second keeps JSON.stringify(workspace) off every
// commit's macrotask cadence; pagehide still force-flushes.
const CACHE_FLUSH_THROTTLE_MS = 1000;

function cachePayload(workspace) {
  return {
    ...workspace,
    assets: Object.fromEntries(Object.entries(workspace.assets || {}).map(([id, asset]) => {
      const { dataUrl, blob, ...metadata } = asset;
      return [id, metadata];
    })),
  };
}

function flushWorkspaceCache() {
  if (!pendingCacheWorkspace) return false;
  const workspace = pendingCacheWorkspace;
  pendingCacheWorkspace = null;
  // A workspace past the localStorage quota can never be cached, and retrying
  // re-serializes the whole thing on every commit only to throw again.
  if (cacheQuotaExceededFor && cacheQuotaExceededFor === (workspace.id || "unknown")) return false;
  try {
    measureStage("cache-flush", () => {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(cachePayload(workspace)));
    });
    cacheQuotaExceededFor = null;
    return true;
  } catch {
    cacheQuotaExceededFor = workspace.id || "unknown";
    return false;
  }
}

export function flushWorkspaceCacheNow() {
  return flushWorkspaceCache();
}

function scheduleCacheFlush() {
  if (cacheFlushScheduled) return;
  if (typeof window === "undefined") return;
  cacheFlushScheduled = true;
  const remaining = Math.max(0, CACHE_FLUSH_THROTTLE_MS - (Date.now() - lastCacheFlushAt));
  window.setTimeout(() => {
    cacheFlushScheduled = false;
    if (flushWorkspaceCache()) lastCacheFlushAt = Date.now();
  }, remaining);
}

export function loadNativeWorkspacePath() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(NATIVE_WORKSPACE_PATH_KEY) || "";
  } catch {
    return "";
  }
}

export function saveNativeWorkspacePath(path) {
  if (typeof window === "undefined") return;
  try {
    if (path) window.localStorage.setItem(NATIVE_WORKSPACE_PATH_KEY, String(path));
    else window.localStorage.removeItem(NATIVE_WORKSPACE_PATH_KEY);
  } catch {
    // The workspace folder itself remains the durable source of truth.
  }
}

async function loadNativeWorkspaceSnapshot(browserWorkspace) {
  if (!isTauriRuntime()) return null;
  const invoke = resolveTauriInvoke();
  if (!invoke) return null;
  let path = loadNativeWorkspacePath() || browserWorkspace?.settings?.nativeWorkspacePath || "";
  if (!path) {
    try {
      const remembered = await invoke("workspace_get_last_path", {});
      path = typeof remembered === "string" ? remembered : remembered?.path || "";
      if (path) saveNativeWorkspacePath(path);
    } catch {
      // Older native builds do not have the native marker command. The
      // browser marker and workspace snapshot remain valid fallbacks.
    }
  }
  if (!path) return null;
  try {
    const result = await invoke("workspace_read_snapshot", { path });
    const raw = typeof result === "string" ? result : result?.contents;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function openDatabase() {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.reject(new Error("IndexedDB is unavailable."));
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open local storage."));
  });
}

export function loadWorkspaceCache() {
  if (typeof window === "undefined") return null;
  try {
    const saved = window.localStorage.getItem(CACHE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

export function saveWorkspaceCache(workspace) {
  if (typeof window === "undefined") return false;
  pendingCacheWorkspace = workspace;
  scheduleCacheFlush();
  return true;
}

export async function loadWorkspace() {
  const cachedWorkspace = loadWorkspaceCache();
  let browserWorkspace = null;
  try {
    const database = await openDatabase();
    const result = await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(CURRENT_WORKSPACE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Unable to read local workspace."));
    });
    database.close();
    const storedTime = Date.parse(result?.updatedAt || "") || 0;
    const cachedTime = Date.parse(cachedWorkspace?.updatedAt || "") || 0;
    browserWorkspace = cachedTime > storedTime ? cachedWorkspace : result || cachedWorkspace;
  } catch {
    browserWorkspace = cachedWorkspace;
  }
  // A selected native folder is canonical. The browser cache is only a
  // fallback for a first launch or when the folder is temporarily unavailable.
  return (await loadNativeWorkspaceSnapshot(browserWorkspace)) || browserWorkspace;
}

export async function saveWorkspace(workspace) {
  // The cache write is normally write-behind; when the legacy snapshot path
  // runs (shadow persistence unavailable) flush it before the IndexedDB write
  // so a crash between the two leaves the freshest value in the cache too.
  saveWorkspaceCache(workspace);
  flushWorkspaceCacheNow();

  try {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(workspace, CURRENT_WORKSPACE_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Unable to save local workspace."));
    });
    database.close();
    return true;
  } catch {
    return false;
  }
}

// Best-effort durability: flush the write-behind boot cache when the page is
// hidden/discarded so the last edits survive a reload or tab close.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushWorkspaceCacheNow);
}
