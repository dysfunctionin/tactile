import assert from "node:assert/strict";

import {
  browserSessionForPage,
  cleanupRetiredBrowserSessions,
  createBrowserSession,
  listOrphanedBrowserSessions,
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

class MemoryIndexedDB {
  constructor(blocked = new Set()) {
    this.blocked = blocked;
    this.deleted = [];
  }

  deleteDatabase(databaseName) {
    const request = {};
    queueMicrotask(() => {
      if (this.blocked.has(databaseName)) request.onblocked();
      else {
        this.deleted.push(databaseName);
        request.onsuccess();
      }
    });
    return request;
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

scenario("importing establishes matching change and export timestamps", () => {
  const localStorage = new MemoryStorage();
  let timestamp = 100;
  const session = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    now: () => timestamp,
  });
  timestamp = 200;
  session.markDirty();
  timestamp = 300;

  session.markImported();

  const record = registryFrom(localStorage)[session.sessionId];
  assert.equal(record.lastChangedAt, 300);
  assert.equal(record.lastExportedAt, 300);
  assert.equal(record.needsExport, false);
  assert.equal(session.needsExport, false);
});

scenario("dirty closed workspaces are listed newest first with browser timestamps", () => {
  const localStorage = new MemoryStorage();
  let timestamp = 100;
  const first = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    now: () => timestamp,
  });
  first.syncWorkspace({ id: "workspace-first", name: "First workspace" });
  timestamp = 200;
  first.markDirty();
  first.markClosed();

  timestamp = 300;
  const second = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    now: () => timestamp,
  });
  second.syncWorkspace({ id: "workspace-second", name: "Second workspace" });
  second.markDirty();
  second.markClosed();

  assert.deepEqual(listOrphanedBrowserSessions({ localStorage }), [
    {
      sessionId: second.sessionId,
      workspaceId: "workspace-second",
      workspaceName: "Second workspace",
      lastChangedAt: 300,
      lastExportedAt: 0,
    },
    {
      sessionId: first.sessionId,
      workspaceId: "workspace-first",
      workspaceName: "First workspace",
      lastChangedAt: 200,
      lastExportedAt: 0,
    },
  ]);
});

scenario("clean closed workspaces are not offered for restoration", () => {
  const localStorage = new MemoryStorage();
  const session = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    now: () => 100,
  });
  session.syncWorkspace({ id: "clean-workspace", name: "Clean workspace" });
  session.markClosed();

  assert.deepEqual(listOrphanedBrowserSessions({ localStorage }), []);
  assert.equal(registryFrom(localStorage)[session.sessionId].state, "discardable");
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

scenario("cleanup turns an expired dirty tab into a recoverable orphan", async () => {
  const localStorage = new MemoryStorage();
  let timestamp = 100;
  const session = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    BroadcastChannel: null,
    now: () => timestamp,
  });
  session.syncWorkspace({ id: "crashed-workspace", name: "Crashed workspace" });
  timestamp = 200;
  session.markDirty();

  const removed = await cleanupRetiredBrowserSessions({
    localStorage,
    indexedDB: new MemoryIndexedDB(),
    BroadcastChannel: null,
    now: () => 60_000,
  });

  assert.deepEqual(removed, []);
  assert.equal(registryFrom(localStorage)[session.sessionId].state, "orphan");
  assert.equal(listOrphanedBrowserSessions({ localStorage })[0].workspaceName, "Crashed workspace");
});

scenario("discard all reports blocked databases and removes the rest", async () => {
  const localStorage = new MemoryStorage();
  const createOrphan = (name, timestamp) => {
    const session = createBrowserSession({
      localStorage,
      sessionStorage: new MemoryStorage(),
      performance: performanceWith("navigate"),
      now: () => timestamp,
    });
    session.syncWorkspace({ id: `workspace-${name}`, name });
    session.markDirty();
    session.markClosed();
    return session;
  };
  const removable = createOrphan("Removable", 100);
  const blocked = createOrphan("Blocked", 200);
  const indexedDB = new MemoryIndexedDB(new Set([blocked.databaseName]));
  const manager = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    indexedDB,
    locks: null,
    now: () => 300,
  });

  const result = await manager.discardAllOrphans();

  assert.deepEqual(result.removed, [removable.sessionId]);
  assert.deepEqual(result.failed, [blocked.sessionId]);
  assert.equal(registryFrom(localStorage)[removable.sessionId], undefined);
  assert.equal(registryFrom(localStorage)[blocked.sessionId].state, "orphan");
});

scenario("restore exclusively claims an orphan and preserves the dirty current workspace", async () => {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  let timestamp = 100;
  let reloads = 0;
  let replacedUrl = "";
  const current = createBrowserSession({
    localStorage,
    sessionStorage,
    performance: performanceWith("navigate"),
    locks: null,
    location: {
      href: "https://example.test/app/",
      reload() {
        reloads += 1;
      },
    },
    history: {
      replaceState(_state, _title, url) {
        replacedUrl = String(url);
      },
    },
    now: () => timestamp,
  });
  current.syncWorkspace({ id: "current-workspace", name: "Current workspace" });
  timestamp = 200;
  current.markDirty();
  sessionStorage.setItem("tactile.browser.boot.v1", JSON.stringify({ activeWorkspaceId: "current-workspace" }));
  const registry = registryFrom(localStorage);
  registry.target = {
    ownerId: "target-owner",
    state: "orphan",
    needsExport: true,
    databaseName: "target-database",
    workspaceId: "target-workspace",
    workspaceName: "Target workspace",
    lastChangedAt: 150,
    lastExportedAt: 0,
    lastSeen: 150,
  };
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));

  assert.equal(await current.restoreOrphan("target"), true);
  assert.equal(await current.restoreOrphan("target"), false);

  const restoredRegistry = registryFrom(localStorage);
  assert.equal(restoredRegistry.target.state, "claimed");
  assert.equal(restoredRegistry[current.sessionId].state, "orphan");
  assert.equal(sessionStorage.getItem("tactile.browser.session.v1"), "target");
  assert.equal(sessionStorage.getItem("tactile.browser.boot.v1"), null);
  assert.match(replacedUrl, /restore-session=target/);
  assert.equal(reloads, 1);
});

scenario("cleanup preserves a recent restore claim and recovers it after the lease expires", async () => {
  const localStorage = new MemoryStorage();
  localStorage.setItem(
    REGISTRY_KEY,
    JSON.stringify({
      claimed: {
        ownerId: "claim-owner",
        state: "claimed",
        needsExport: true,
        databaseName: "claimed-database",
        workspaceId: "claimed-workspace",
        workspaceName: "Claimed workspace",
        lastChangedAt: 100,
        lastExportedAt: 0,
        lastSeen: 1_000,
      },
    }),
  );

  await cleanupRetiredBrowserSessions({
    localStorage,
    indexedDB: new MemoryIndexedDB(),
    BroadcastChannel: null,
    now: () => 2_000,
  });
  assert.equal(registryFrom(localStorage).claimed.state, "claimed");

  await cleanupRetiredBrowserSessions({
    localStorage,
    indexedDB: new MemoryIndexedDB(),
    BroadcastChannel: null,
    now: () => 20_000,
  });
  assert.equal(registryFrom(localStorage).claimed.state, "orphan");
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
