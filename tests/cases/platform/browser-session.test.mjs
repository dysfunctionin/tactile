import assert from "node:assert/strict";

import {
  browserSessionForPage,
  cleanupRetiredBrowserSessions,
  createBrowserSession,
} from "../../../src/platform/browser/session.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "platform", suite: "browser-session" });
const REGISTRY_KEY = "tactile.browser.sessions.v1";

class MemoryStorage {
  constructor(values = new Map()) {
    this.values = values;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function performanceWith(type) {
  return { getEntriesByType: () => [{ type }] };
}

function registryFrom(storage) {
  return JSON.parse(storage.getItem(REGISTRY_KEY) || "{}");
}

class MemoryBroadcastChannel {
  static channels = new Map();

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    const members = MemoryBroadcastChannel.channels.get(name) || new Set();
    members.add(this);
    MemoryBroadcastChannel.channels.set(name, members);
  }

  postMessage(data) {
    for (const member of MemoryBroadcastChannel.channels.get(this.name) || []) {
      if (member !== this) member.onmessage?.({ data });
    }
  }

  close() {
    MemoryBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

scenario("a browser tab reuses its isolated persistence session across reloads", () => {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const first = createBrowserSession({
    localStorage,
    sessionStorage,
    performance: performanceWith("navigate"),
    now: () => 100,
  });
  const reloaded = createBrowserSession({
    localStorage,
    sessionStorage,
    performance: performanceWith("reload"),
    now: () => 200,
  });

  assert.equal(first.isNew, true);
  assert.equal(reloaded.isNew, false);
  assert.equal(reloaded.sessionId, first.sessionId);
  assert.equal(reloaded.databaseName, first.databaseName);
});

scenario("a new tab with copied session storage rotates to an isolated workspace", () => {
  const localStorage = new MemoryStorage();
  const sourceStorage = new MemoryStorage();
  const first = createBrowserSession({
    localStorage,
    sessionStorage: sourceStorage,
    performance: performanceWith("navigate"),
    now: () => 100,
  });
  const copiedStorage = new MemoryStorage(new Map(sourceStorage.values));
  const second = createBrowserSession({
    localStorage,
    sessionStorage: copiedStorage,
    performance: performanceWith("navigate"),
    now: () => 200,
  });

  assert.equal(second.isNew, true);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.notEqual(second.databaseName, first.databaseName);
});

scenario("a new navigation after closing a tab starts an isolated workspace", () => {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const closed = createBrowserSession({
    localStorage,
    sessionStorage,
    performance: performanceWith("navigate"),
    now: () => 100,
  });
  closed.markDirty();
  closed.markClosed();

  const reopened = createBrowserSession({
    localStorage,
    sessionStorage,
    performance: performanceWith("navigate"),
    now: () => 200,
  });

  assert.equal(reopened.isNew, true);
  assert.equal(reopened.needsExport, false);
  assert.notEqual(reopened.sessionId, closed.sessionId);
});

scenario("canceling close protection returns a dirty session to active ownership", () => {
  const localStorage = new MemoryStorage();
  const session = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    now: () => 100,
  });
  session.markDirty();
  session.markClosePending();
  session.resume();

  assert.equal(session.needsExport, true);
  assert.equal(session.ownsSession, true);
  assert.equal(registryFrom(localStorage)[session.sessionId].state, "active");
});

scenario("exporting clears close protection metadata", () => {
  const localStorage = new MemoryStorage();
  const session = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
  });
  session.markDirty();
  assert.equal(session.needsExport, true);

  session.markExported();

  assert.equal(session.needsExport, false);
});

scenario("strict rendering initializes one browser session per page", () => {
  const options = {
    host: {},
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
  };

  const firstRender = browserSessionForPage(options);
  const secondRender = browserSessionForPage(options);

  assert.equal(secondRender, firstRender);
});

scenario("cleanup removes retired recovery records and preserves the current session", async () => {
  const localStorage = new MemoryStorage();
  localStorage.setItem(
    REGISTRY_KEY,
    JSON.stringify({
      orphaned: {
        ownerId: "old-orphan-owner",
        state: "orphan",
        needsExport: true,
        databaseName: "retired-orphan-database",
        lastSeen: 100,
      },
      claimed: {
        ownerId: "old-claim-owner",
        state: "claimed",
        needsExport: true,
        databaseName: "retired-claim-database",
        lastSeen: 100,
      },
    }),
  );
  const current = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    now: () => 20_000,
  });

  const removed = await cleanupRetiredBrowserSessions({
    localStorage,
    indexedDB: null,
    excludeSessionId: current.sessionId,
    now: () => 20_000,
  });

  assert.deepEqual(removed.sort(), ["claimed", "orphaned"]);
  assert.deepEqual(Object.keys(registryFrom(localStorage)), [current.sessionId]);
});

scenario("cleanup excludes another live tab even after its lease age", async () => {
  const localStorage = new MemoryStorage();
  const live = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    BroadcastChannel: MemoryBroadcastChannel,
    now: () => 100,
  });

  const removed = await cleanupRetiredBrowserSessions({
    localStorage,
    indexedDB: null,
    BroadcastChannel: MemoryBroadcastChannel,
    probeMs: 0,
    now: () => 60_000,
  });

  assert.deepEqual(removed, []);
  assert.ok(registryFrom(localStorage)[live.sessionId]);
  live.dispose();
});

scenario("cleanup waits for an active lease before removing an unresponsive tab", async () => {
  const localStorage = new MemoryStorage();
  const session = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    BroadcastChannel: null,
    now: () => 100,
  });
  session.dispose();

  assert.deepEqual(
    await cleanupRetiredBrowserSessions({
      localStorage,
      indexedDB: null,
      BroadcastChannel: null,
      now: () => 1_000,
    }),
    [],
  );
  assert.deepEqual(
    await cleanupRetiredBrowserSessions({
      localStorage,
      indexedDB: null,
      BroadcastChannel: null,
      now: () => 60_000,
    }),
    [session.sessionId],
  );
});

scenario("a blocked database deletion remains registered for retry", async () => {
  const localStorage = new MemoryStorage();
  localStorage.setItem(
    REGISTRY_KEY,
    JSON.stringify({
      retired: {
        ownerId: "retired-owner",
        state: "orphan",
        needsExport: true,
        databaseName: "retired-database",
        lastSeen: 100,
      },
    }),
  );
  const blockedIndexedDB = {
    deleteDatabase() {
      const request = {};
      queueMicrotask(() => request.onblocked());
      return request;
    },
  };

  const removed = await cleanupRetiredBrowserSessions({
    localStorage,
    indexedDB: blockedIndexedDB,
    BroadcastChannel: null,
    now: () => 60_000,
  });

  assert.deepEqual(removed, []);
  assert.ok(registryFrom(localStorage).retired);
});
