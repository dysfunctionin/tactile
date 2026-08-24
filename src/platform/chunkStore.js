import { hydrateWorkspaceCells, virtualSheetIds } from "../core/dataset/index.ts";
import { createBrowserChunkStore } from "./browser/chunkStore.js";
import { openRecordDatabase } from "./browser/indexedDb.js";
import { loadWorkspaceBootState } from "./browser/storage.js";
import { createNativeChunkStore } from "./tauri/chunkStore.ts";
import { isTauriRuntime } from "./tauri/runtime.ts";

/**
 * Picks the backing store for a workspace's cell blocks.
 *
 * The store is opened on first use rather than eagerly, because a workspace
 * small enough to stay eager never reads a block and should not pay to open a
 * database it will not touch.
 */
function deferred(open) {
  let opening = null;
  const resolve = () => {
    opening = opening || open();
    return opening;
  };
  return {
    readChunks: async (objectId, chunkKeys) => (await resolve()).readChunks(objectId, chunkKeys),
    listChunkKeys: async (objectId) => (await resolve()).listChunkKeys(objectId),
    writeChunks: async (objectId, put, remove) => (await resolve()).writeChunks(objectId, put, remove),
    dropObject: async (objectId) => (await resolve()).dropObject(objectId),
  };
}

const stores = new Map();

export function createChunkStore(workspaceId) {
  if (isTauriRuntime()) return createNativeChunkStore(workspaceId);
  return deferred(async () => createBrowserChunkStore(await openRecordDatabase({}), workspaceId));
}

/** One store per workspace, so every sheet in it shares a connection. */
export function chunkStoreFor(workspaceId) {
  const id = String(workspaceId);
  let store = stores.get(id);
  if (!store) {
    store = createChunkStore(id);
    stores.set(id, store);
  }
  return store;
}

export function releaseChunkStore(workspaceId) {
  stores.delete(String(workspaceId));
}

/**
 * The store for the workspace currently open.
 *
 * Blocks are keyed by workspace, so reading them needs the same id the
 * persistence layer wrote under; boot state is where that id already lives.
 * A workspace that has never been saved has no blocks to read, and the null
 * keeps its sheets on the eager path.
 */
export function activeChunkStore() {
  const workspaceId = loadWorkspaceBootState()?.workspaceId;
  return workspaceId ? chunkStoreFor(workspaceId) : null;
}

/**
 * The workspace as a serializer must see it: every cell of every sheet.
 *
 * Returns the same object when nothing is partial, so the eager path stays a
 * single `await` with no copying.
 */
export async function hydrateWorkspaceForExport(workspace) {
  const objectIds = virtualSheetIds(workspace);
  if (!objectIds.length) return workspace;
  return hydrateWorkspaceCells(activeChunkStore(), workspace, objectIds);
}
