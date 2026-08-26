import { BROWSER_DATABASE_NAME } from "./constants.js";
import { createBrowserPersistence } from "./persistence.js";

const SESSION_ID_KEY = "tactile.browser.session.v1";
const SESSION_REGISTRY_KEY = "tactile.browser.sessions.v1";
const ACTIVE_LEASE_MS = 15_000;
const LIVENESS_CHANNEL = "tactile.browser.session-liveness.v1";
const PAGE_SESSION_KEY = Symbol.for("tactile.browser.page-session.v1");

function randomId(prefix) {
  const random = globalThis.crypto?.randomUUID?.()
    || Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

function readRegistry(storage) {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(SESSION_REGISTRY_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeRegistry(storage, registry) {
  if (!storage) return;
  try {
    storage.setItem(SESSION_REGISTRY_KEY, JSON.stringify(registry));
  } catch {
    // Session isolation still works when shared lifecycle metadata is blocked.
  }
}

function storageFor(value, name) {
  if (value !== undefined) return value;
  return typeof globalThis !== "undefined" ? globalThis[name] : null;
}

function nowFor(options) {
  return options.now?.() ?? Date.now();
}

function updateOwnedSession(localStorage, sessionId, ownerId, patch, now) {
  const registry = readRegistry(localStorage);
  const current = registry[sessionId];
  if (!current || current.ownerId !== ownerId) return false;
  registry[sessionId] = {
    ...current,
    ...patch,
    lastSeen: now,
  };
  writeRegistry(localStorage, registry);
  return true;
}

async function liveSessionIds(sessionIds, options = {}) {
  const Channel = options.BroadcastChannel
    ?? (typeof window !== "undefined" ? window.BroadcastChannel : null);
  if (!Channel || !sessionIds.length) return new Set();
  const channel = new Channel(LIVENESS_CHANNEL);
  const alive = new Set();
  const nonce = randomId("probe");
  channel.onmessage = (event) => {
    if (event.data?.type === "alive" && event.data.nonce === nonce && sessionIds.includes(event.data.sessionId)) {
      alive.add(event.data.sessionId);
    }
  };
  channel.postMessage({ type: "probe", nonce });
  await new Promise((resolve) => setTimeout(resolve, options.probeMs ?? 120));
  channel.close();
  return alive;
}

function deleteDatabase(indexedDB, databaseName) {
  if (!indexedDB) return Promise.resolve(true);
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
    request.onblocked = () => resolve(false);
  });
}

export async function cleanupRetiredBrowserSessions(options = {}) {
  const localStorage = storageFor(options.localStorage, "localStorage");
  const indexedDB = options.indexedDB
    ?? (typeof globalThis !== "undefined" ? globalThis.indexedDB : null);
  const excludeSessionId = options.excludeSessionId || null;
  const candidateIds = Object.keys(readRegistry(localStorage))
    .filter((sessionId) => sessionId !== excludeSessionId);
  const alive = await liveSessionIds(candidateIds, options);
  const removed = [];

  for (const sessionId of candidateIds) {
    if (alive.has(sessionId)) continue;
    const registry = readRegistry(localStorage);
    const record = registry[sessionId];
    if (!record) continue;
    const recentOwner = ["active", "close-pending"].includes(record.state)
      && nowFor(options) - Number(record.lastSeen || 0) < ACTIVE_LEASE_MS;
    if (recentOwner) continue;
    const databaseName = record.databaseName || `${BROWSER_DATABASE_NAME}-${sessionId}`;
    if (!await deleteDatabase(indexedDB, databaseName)) continue;
    const latest = readRegistry(localStorage);
    const unchanged = latest[sessionId]?.ownerId === record.ownerId
      && latest[sessionId]?.lastSeen === record.lastSeen;
    if (!unchanged) continue;
    delete latest[sessionId];
    writeRegistry(localStorage, latest);
    removed.push(sessionId);
  }

  return removed;
}

function navigationType(performanceApi) {
  return performanceApi?.getEntriesByType?.("navigation")?.[0]?.type || "navigate";
}

export function createBrowserSession(options = {}) {
  const sessionStorage = storageFor(options.sessionStorage, "sessionStorage");
  const localStorage = storageFor(options.localStorage, "localStorage");
  const performanceApi = options.performance
    ?? (typeof globalThis !== "undefined" ? globalThis.performance : null);
  const now = nowFor(options);
  const ownerId = randomId("owner");
  const registry = readRegistry(localStorage);
  let sessionId = sessionStorage?.getItem(SESSION_ID_KEY) || "";
  const isReload = navigationType(performanceApi) === "reload";

  let isNew = !sessionId;
  if (sessionId && !isReload) {
    sessionId = "";
    isNew = true;
  }
  if (!sessionId) sessionId = randomId("session");

  sessionStorage?.setItem(SESSION_ID_KEY, sessionId);
  const databaseName = `${BROWSER_DATABASE_NAME}-${sessionId}`;
  registry[sessionId] = {
    ...(registry[sessionId] || {}),
    ownerId,
    state: "active",
    lastSeen: now,
    databaseName,
  };
  writeRegistry(localStorage, registry);

  const session = {
    sessionId,
    ownerId,
    databaseName,
    isNew,
    persistence: createBrowserPersistence({
      databaseName,
      localStorage: sessionStorage,
      autoMigrate: false,
    }),
    heartbeat() {
      return updateOwnedSession(localStorage, sessionId, ownerId, { state: "active" }, Date.now());
    },
    markDirty() {
      return updateOwnedSession(localStorage, sessionId, ownerId, {
        needsExport: true,
        state: "active",
      }, Date.now());
    },
    markExported() {
      return updateOwnedSession(localStorage, sessionId, ownerId, { needsExport: false, state: "active" }, Date.now());
    },
    markClosePending() {
      const timestamp = Date.now();
      return updateOwnedSession(localStorage, sessionId, ownerId, {
        state: "close-pending",
        closeRequestedAt: timestamp,
      }, timestamp);
    },
    resume() {
      return updateOwnedSession(localStorage, sessionId, ownerId, {
        state: "active",
        closeRequestedAt: null,
        closedAt: null,
      }, Date.now());
    },
    markClosed() {
      const timestamp = Date.now();
      return updateOwnedSession(localStorage, sessionId, ownerId, {
        state: "discardable",
        closedAt: timestamp,
      }, timestamp);
    },
    get needsExport() {
      return readRegistry(localStorage)[sessionId]?.needsExport === true;
    },
    get ownsSession() {
      const fresh = readRegistry(localStorage)[sessionId];
      return fresh?.ownerId === ownerId;
    },
    cleanupRetired() {
      return cleanupRetiredBrowserSessions({ localStorage, excludeSessionId: sessionId });
    },
  };
  const Channel = options.BroadcastChannel
    ?? (typeof window !== "undefined" ? window.BroadcastChannel : null);
  const livenessChannel = Channel ? new Channel(LIVENESS_CHANNEL) : null;
  if (livenessChannel) {
    livenessChannel.onmessage = (event) => {
      if (event.data?.type !== "probe" || !session.ownsSession) return;
      livenessChannel.postMessage({ type: "alive", nonce: event.data.nonce, sessionId });
    };
  }
  session.dispose = () => livenessChannel?.close();
  return session;
}

export function browserSessionForPage(options = {}) {
  const host = options.host
    ?? (typeof window !== "undefined" ? window : globalThis);
  if (!host[PAGE_SESSION_KEY]) {
    Object.defineProperty(host, PAGE_SESSION_KEY, {
      configurable: true,
      value: createBrowserSession(options),
    });
  }
  return host[PAGE_SESSION_KEY];
}
