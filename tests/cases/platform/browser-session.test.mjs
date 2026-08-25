import assert from "node:assert/strict";

import {
  browserSessionForPage,
  claimOrphanedBrowserSessions,
  cleanupDiscardableBrowserSessions,
  createBrowserSession,
  discoverOrphanedBrowserSessions,
  probeOrphanedBrowserSessions,
  releaseBrowserSessionClaim,
} from "../../../src/platform/browser/session.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "platform", suite: "browser-session" });

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

scenario("reopening a closed session without a restore token starts clean", () => {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const closed = createBrowserSession({
    localStorage,
    sessionStorage,
    performance: performanceWith("navigate"),
    now: () => 100,
  });
  closed.markDirty("Closed workspace");
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
  assert.equal(
    discoverOrphanedBrowserSessions({ localStorage, now: () => Date.now() + 60_000 }).some(
      (session) => session.sessionId === closed.sessionId,
    ),
    true,
  );
});

scenario("canceling a close returns the dirty session to active ownership", () => {
  const localStorage = new MemoryStorage();
  const session = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    now: () => 100,
  });
  session.markDirty("Budget model");
  session.markClosePending();
  session.resume();

  assert.equal(session.needsExport, true);
  assert.deepEqual(discoverOrphanedBrowserSessions({ localStorage, now: () => Date.now() }), []);
});

scenario("a confirmed dirty close becomes recoverable while an exported close does not", () => {
  const localStorage = new MemoryStorage();
  const dirty = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    now: () => 100,
  });
  dirty.markDirty("Unsaved model");
  dirty.markClosed();
  const exported = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    now: () => 200,
  });
  exported.markDirty("Saved model");
  exported.markExported();
  exported.markClosed();

  const orphans = discoverOrphanedBrowserSessions({ localStorage, now: () => Date.now() + 60_000 });
  assert.deepEqual(
    orphans.map((entry) => entry.workspaceLabel),
    ["Unsaved model"],
  );
});

scenario("a crashed dirty owner becomes recoverable after its lease expires", () => {
  const localStorage = new MemoryStorage();
  const session = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    now: () => 100,
  });
  session.markDirty("Crash recovery");

  const orphans = discoverOrphanedBrowserSessions({ localStorage, now: () => Date.now() + 60_000 });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].sessionId, session.sessionId);
});

scenario("restore claims are single-use and can be released after popup blocking", () => {
  const localStorage = new MemoryStorage();
  const session = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    now: () => 100,
  });
  session.markDirty("Restore me");
  session.markClosed();
  const [claim] = claimOrphanedBrowserSessions([session.sessionId], { localStorage, now: () => 1_000 });

  assert.ok(claim.restoreToken);
  assert.deepEqual(discoverOrphanedBrowserSessions({ localStorage, now: () => Date.now() + 60_000 }), []);
  assert.equal(releaseBrowserSessionClaim(claim.restoreToken, { localStorage }), true);
  assert.equal(discoverOrphanedBrowserSessions({ localStorage, now: () => Date.now() + 60_000 }).length, 1);
});

scenario("a restore token adopts exactly one orphaned database", () => {
  const localStorage = new MemoryStorage();
  const originalStorage = new MemoryStorage();
  const original = createBrowserSession({
    localStorage,
    sessionStorage: originalStorage,
    performance: performanceWith("navigate"),
    now: () => 100,
  });
  original.markDirty("Recovered workspace");
  original.markClosed();
  const [claim] = claimOrphanedBrowserSessions([original.sessionId], { localStorage, now: () => 1_000 });
  const restored = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    restoreToken: claim.restoreToken,
    now: () => 2_000,
  });

  assert.equal(restored.restored, true);
  assert.equal(restored.isNew, false);
  assert.equal(restored.sessionId, original.sessionId);
  assert.equal(restored.databaseName, original.databaseName);
  assert.equal(original.ownsSession, false);
});

scenario("strict rendering initializes one restored session per page", () => {
  const localStorage = new MemoryStorage();
  const original = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    now: () => 100,
  });
  original.markDirty("Recovered once");
  original.markClosed();
  const [claim] = claimOrphanedBrowserSessions([original.sessionId], { localStorage, now: () => 1_000 });
  const options = {
    host: {},
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    restoreToken: claim.restoreToken,
    now: () => 2_000,
  };

  const firstRender = browserSessionForPage(options);
  const secondRender = browserSessionForPage(options);

  assert.equal(secondRender, firstRender);
  assert.equal(secondRender.restored, true);
  assert.equal(secondRender.sessionId, original.sessionId);
});

scenario("a liveness response excludes a dirty active tab from recovery", async () => {
  const localStorage = new MemoryStorage();
  const live = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    BroadcastChannel: MemoryBroadcastChannel,
  });
  live.markDirty("Still open");

  const candidates = await probeOrphanedBrowserSessions({
    localStorage,
    BroadcastChannel: MemoryBroadcastChannel,
    probeMs: 0,
  });

  assert.deepEqual(candidates, []);
  live.dispose();
});

scenario("a force-closed tab is recoverable as soon as its liveness channel disappears", async () => {
  const localStorage = new MemoryStorage();
  const closed = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
    BroadcastChannel: MemoryBroadcastChannel,
  });
  closed.markDirty("Force closed");
  closed.dispose();

  const candidates = await probeOrphanedBrowserSessions({
    localStorage,
    BroadcastChannel: MemoryBroadcastChannel,
    probeMs: 0,
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.workspaceLabel),
    ["Force closed"],
  );
});

scenario("an unanswered close prompt becomes recoverable only after its grace period", () => {
  const localStorage = new MemoryStorage();
  const pending = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
  });
  pending.markDirty("Waiting for close answer");
  pending.markClosePending();

  assert.deepEqual(discoverOrphanedBrowserSessions({ localStorage, now: () => Date.now() }), []);
  assert.equal(discoverOrphanedBrowserSessions({ localStorage, now: () => Date.now() + 60_000 }).length, 1);
});

scenario("restore tabs claims every orphan with a distinct one-time token", () => {
  const localStorage = new MemoryStorage();
  const sessions = ["First orphan", "Second orphan"].map((label) => {
    const session = createBrowserSession({
      localStorage,
      sessionStorage: new MemoryStorage(),
      performance: performanceWith("navigate"),
    });
    session.markDirty(label);
    session.markClosed();
    return session;
  });

  const claims = claimOrphanedBrowserSessions(
    sessions.map((session) => session.sessionId),
    { localStorage },
  );
  assert.equal(claims.length, 2);
  assert.equal(new Set(claims.map((claim) => claim.restoreToken)).size, 2);
  assert.deepEqual(discoverOrphanedBrowserSessions({ localStorage, now: () => Date.now() + 60_000 }), []);
});

scenario("closed blank and exported sessions are removed without affecting dirty orphans", async () => {
  const localStorage = new MemoryStorage();
  const blank = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
  });
  blank.markClosed();
  const exported = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
  });
  exported.markDirty("Exported");
  exported.markExported();
  exported.markClosed();
  const dirty = createBrowserSession({
    localStorage,
    sessionStorage: new MemoryStorage(),
    performance: performanceWith("navigate"),
  });
  dirty.markDirty("Keep me");
  dirty.markClosed();

  await cleanupDiscardableBrowserSessions({ localStorage, indexedDB: null });

  const orphans = discoverOrphanedBrowserSessions({ localStorage, now: () => Date.now() + 60_000 });
  assert.deepEqual(
    orphans.map((orphan) => orphan.sessionId),
    [dirty.sessionId],
  );
});
