import { BROWSER_DATABASE_NAME } from "./constants.js";
import { createBrowserPersistence } from "./persistence.js";

const SESSION_ID_KEY = "tactile.browser.session.v1";
const SESSION_REGISTRY_KEY = "tactile.browser.sessions.v1";
const ACTIVE_LEASE_MS = 15_000;
const CLOSE_GRACE_MS = 2_000;
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
  if (!current || current.ownerId !== ownerId || current.state === "claimed") return false;
  registry[sessionId] = {
    ...current,
    ...patch,
    lastSeen: now,
  };
  writeRegistry(localStorage, registry);
  return true;
}

export function discoverOrphanedBrowserSessions(options = {}) {
  const localStorage = storageFor(options.localStorage, "localStorage");
  const now = nowFor(options);
  const excludeSessionId = options.excludeSessionId || null;
  return Object.entries(readRegistry(localStorage))
    .filter(([sessionId, record]) => {
      if (sessionId === excludeSessionId || !record?.needsExport) return false;
      if (record.state === "orphan") return now - Number(record.closedAt || record.lastSeen || 0) >= CLOSE_GRACE_MS;
      if (record.state === "close-pending") return now - Number(record.closeRequestedAt || record.lastSeen || 0) >= ACTIVE_LEASE_MS;
      return record.state === "active" && now - Number(record.lastSeen || 0) >= ACTIVE_LEASE_MS;
    })
    .map(([sessionId, record]) => ({
      sessionId,
      databaseName: record.databaseName || `${BROWSER_DATABASE_NAME}-${sessionId}`,
      workspaceLabel: record.workspaceLabel || "Untitled workspace",
      closedAt: record.closedAt || record.closeRequestedAt || record.lastSeen || null,
    }))
    .sort((left, right) => Number(right.closedAt || 0) - Number(left.closedAt || 0));
}

export function claimOrphanedBrowserSessions(sessionIds, options = {}) {
  const localStorage = storageFor(options.localStorage, "localStorage");
  const registry = readRegistry(localStorage);
  const claims = [];
  for (const sessionId of sessionIds) {
    const current = registry[sessionId];
    if (!current?.needsExport || !["orphan", "close-pending", "active"].includes(current.state)) continue;
    const restoreToken = randomId("restore");
    registry[sessionId] = { ...current, state: "claimed", restoreToken, claimedAt: nowFor(options) };
    claims.push({ sessionId, restoreToken });
  }
  writeRegistry(localStorage, registry);
  return claims;
}

export function releaseBrowserSessionClaim(restoreToken, options = {}) {
  const localStorage = storageFor(options.localStorage, "localStorage");
  const registry = readRegistry(localStorage);
  const entry = Object.entries(registry).find(([, record]) => record?.restoreToken === restoreToken);
  if (!entry) return false;
  const [sessionId, record] = entry;
  registry[sessionId] = { ...record, state: "orphan", restoreToken: null, claimedAt: null };
  writeRegistry(localStorage, registry);
  return true;
}

export async function deleteBrowserSessions(sessionIds, options = {}) {
  const localStorage = storageFor(options.localStorage, "localStorage");
  const indexedDB = options.indexedDB
    ?? (typeof globalThis !== "undefined" ? globalThis.indexedDB : null);
  const registry = readRegistry(localStorage);
  for (const sessionId of sessionIds) {
    const record = registry[sessionId];
    const databaseName = record?.databaseName || `${BROWSER_DATABASE_NAME}-${sessionId}`;
    if (indexedDB) {
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      });
    }
    delete registry[sessionId];
  }
  writeRegistry(localStorage, registry);
}

export function cleanupDiscardableBrowserSessions(options = {}) {
  const localStorage = storageFor(options.localStorage, "localStorage");
  const sessionIds = Object.entries(readRegistry(localStorage))
    .filter(([, record]) => record?.state === "discardable" || record?.needsExport === false && record?.state !== "active")
    .map(([sessionId]) => sessionId);
  return deleteBrowserSessions(sessionIds, { ...options, localStorage });
}

export async function probeOrphanedBrowserSessions(options = {}) {
  const localStorage = storageFor(options.localStorage, "localStorage");
  const now = nowFor(options);
  const candidates = Object.entries(readRegistry(localStorage))
    .filter(([sessionId, record]) => {
      if (sessionId === options.excludeSessionId || !record?.needsExport || record.state === "claimed") return false;
      if (record.state === "orphan") return now - Number(record.closedAt || record.lastSeen || 0) >= CLOSE_GRACE_MS;
      if (record.state === "close-pending") {
        return now - Number(record.closeRequestedAt || record.lastSeen || 0) >= ACTIVE_LEASE_MS;
      }
      return record.state === "active";
    })
    .map(([sessionId, record]) => ({
      sessionId,
      databaseName: record.databaseName || `${BROWSER_DATABASE_NAME}-${sessionId}`,
      workspaceLabel: record.workspaceLabel || "Untitled workspace",
      closedAt: record.closedAt || record.closeRequestedAt || record.lastSeen || null,
    }));
  const Channel = options.BroadcastChannel
    ?? (typeof window !== "undefined" ? window.BroadcastChannel : null);
  if (!candidates.length) return candidates;
  if (!Channel) return discoverOrphanedBrowserSessions(options);
  const channel = new Channel(LIVENESS_CHANNEL);
  const alive = new Set();
  const nonce = randomId("probe");
  channel.onmessage = (event) => {
    if (event.data?.type === "alive" && event.data.nonce === nonce) alive.add(event.data.sessionId);
  };
  channel.postMessage({ type: "probe", nonce });
  await new Promise((resolve) => setTimeout(resolve, options.probeMs ?? 120));
  channel.close();
  return candidates.filter((candidate) => !alive.has(candidate.sessionId));
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
  const restoreToken = options.restoreToken || null;
  const restored = restoreToken
    ? Object.entries(registry).find(([, record]) => record?.state === "claimed" && record.restoreToken === restoreToken)
    : null;
  let sessionId = restored?.[0] || sessionStorage?.getItem(SESSION_ID_KEY) || "";
  const existing = sessionId ? registry[sessionId] : null;
  const isReload = navigationType(performanceApi) === "reload";
  const isClaimedByLivePage = existing?.ownerId
    && existing.ownerId !== ownerId
    && existing.state === "active"
    && now - Number(existing.lastSeen || 0) < ACTIVE_LEASE_MS;

  let isNew = !sessionId;
  if (restored) isNew = false;
  if (sessionId && isClaimedByLivePage && !isReload) {
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
    restoreToken: null,
    claimedAt: null,
  };
  writeRegistry(localStorage, registry);

  const session = {
    sessionId,
    ownerId,
    databaseName,
    isNew,
    restored: Boolean(restored),
    persistence: createBrowserPersistence({
      databaseName,
      localStorage: sessionStorage,
      autoMigrate: false,
    }),
    heartbeat() {
      return updateOwnedSession(localStorage, sessionId, ownerId, { state: "active" }, Date.now());
    },
    markDirty(workspaceLabel) {
      return updateOwnedSession(localStorage, sessionId, ownerId, {
        needsExport: true,
        workspaceLabel: workspaceLabel || "Untitled workspace",
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
      const fresh = readRegistry(localStorage)[sessionId];
      const timestamp = Date.now();
      return updateOwnedSession(localStorage, sessionId, ownerId, fresh?.needsExport
        ? { state: "orphan", closedAt: timestamp }
        : { state: "discardable", closedAt: timestamp }, timestamp);
    },
    get needsExport() {
      return readRegistry(localStorage)[sessionId]?.needsExport === true;
    },
    get ownsSession() {
      const fresh = readRegistry(localStorage)[sessionId];
      return fresh?.ownerId === ownerId && fresh.state !== "claimed";
    },
    discoverOrphans() {
      return discoverOrphanedBrowserSessions({ localStorage, excludeSessionId: sessionId });
    },
    probeOrphans() {
      return probeOrphanedBrowserSessions({ localStorage, excludeSessionId: sessionId });
    },
    cleanupDiscardable() {
      return cleanupDiscardableBrowserSessions({ localStorage });
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
