import { createBlankWorkspace, normalizeWorkspace } from "../../core/workspace/model.js";
import { readPortableV4Package } from "../../core/compat/portable.js";
import { buildPortableV4Package, portablePackageToZip } from "../../core/compat/portable.js";
import { buildPortablePackage } from "../../core/workspace/export.js";
import {
  BROWSER_DATABASE_NAME,
  BROWSER_DATABASE_VERSION,
  BOOT_METADATA_KEY,
  LEGACY_CACHE_KEY,
  LEGACY_DATABASE_NAME,
  LEGACY_STORE_NAME,
  LEGACY_WORKSPACE_KEY,
  STORE_NAMES,
} from "./constants.js";
import { AssetUrlRegistry, blobToDataUrl, toNativeBlob } from "./assets.js";
import { readBootMetadata, writeBootMetadata } from "./bootMetadata.js";
import {
  assetFromRecord,
  assetKey,
  assetRecord,
  cellChunkId,
  cellChunkKey,
  cellChunkRecord,
  cellFromRecord,
  cellKey,
  cellsFromChunkRecord,
  objectFromRecord,
  objectKey,
  objectRecord,
  themeFromRecord,
  themeKey,
  themeRecord,
  workspaceKey,
  workspaceMetaFromRecord,
  workspaceMetaRecord,
} from "./records.js";
import {
  indexedDbFor,
  openRecordDatabase,
  readAllRecords,
  readRecord,
  runRecordTransaction,
} from "./indexedDb.js";
import { migrateLegacyWorkspace, readLegacyWorkspace } from "./migration.js";

function now() {
  return new Date().toISOString();
}

function idFromRecord(record, fallback) {
  return String(record?.id || fallback || "");
}

function objectStoreRecord(workspaceId, object) {
  return objectRecord(workspaceId, object);
}

function assetStoreRecord(workspaceId, assetId, asset) {
  const blob = toNativeBlob(asset?.blob || asset?.data || asset?.dataUrl, asset?.mime);
  return assetRecord(workspaceId, assetId, asset, blob);
}

function themeStoreRecord(workspaceId, theme) {
  return themeRecord(workspaceId, theme);
}

function chunkedCellRecords(workspaceId, objectId, cells) {
  const chunks = new Map();
  Object.entries(cells || {}).forEach(([fallbackCellId, cell]) => {
    const chunkId = cellChunkId(cell, fallbackCellId);
    const chunk = chunks.get(chunkId) || {};
    chunk[String(cell?.id || fallbackCellId)] = cell;
    chunks.set(chunkId, chunk);
  });
  return [...chunks].map(([chunkId, chunkCells]) => (
    cellChunkRecord(workspaceId, objectId, chunkId, chunkCells)
  ));
}

function putWorkspaceRecords(transaction, workspace, revision, storageState = "active") {
  const workspaceId = String(workspace.id);
  const metaStore = transaction.objectStore(STORE_NAMES.workspaceMeta);
  const objectStore = transaction.objectStore(STORE_NAMES.objects);
  const cellStore = transaction.objectStore(STORE_NAMES.cells);
  const cellChunkStore = transaction.objectStore(STORE_NAMES.cellChunks);
  const assetStore = transaction.objectStore(STORE_NAMES.assets);
  const themeStore = transaction.objectStore(STORE_NAMES.themes);

  const stores = [
    {
      store: objectStore,
      records: "objects",
      key: (record) => objectKey(record.workspaceId, record.objectId),
    },
    {
      store: cellStore,
      records: "cells",
      key: (record) => cellKey(record.workspaceId, record.objectId, record.cellId),
    },
    {
      store: cellChunkStore,
      records: "cellChunks",
      key: (record) => cellChunkKey(record.workspaceId, record.objectId, record.chunkId),
    },
    {
      store: assetStore,
      records: "assets",
      key: (record) => assetKey(record.workspaceId, record.assetId),
    },
    {
      store: themeStore,
      records: "themes",
      key: (record) => themeKey(record.workspaceId, record.themeId),
    },
  ];
  const previousAssets = new Map();
  let pendingReads = stores.length;

  const writeRecords = () => {
    metaStore.put(workspaceMetaRecord(workspace, revision, storageState));
    Object.values(workspace.objects || {}).forEach((object) => {
      objectStore.put(objectStoreRecord(workspaceId, object));
      chunkedCellRecords(workspaceId, object.id, object.cells).forEach((record) => {
        cellChunkStore.put(record);
      });
    });
    Object.values(workspace.assets || {}).forEach((asset) => {
      const assetId = idFromRecord(asset, asset?.assetId);
      if (!assetId) return;
      const next = assetStoreRecord(workspaceId, assetId, asset);
      const previous = previousAssets.get(assetId);
      if (previous?.blob && !next.blob) next.blob = previous.blob;
      assetStore.put(next);
    });
    Object.values(workspace.themes || {}).forEach((theme) => {
      const themeId = idFromRecord(theme, theme?.themeId);
      if (themeId) themeStore.put(themeStoreRecord(workspaceId, theme));
    });
  };

  stores.forEach(({ store, records, key }) => {
    const read = store.getAll();
    read.onsuccess = () => {
      (read.result || []).forEach((record) => {
        if (record.workspaceId !== workspaceId) return;
        if (records === "assets" && record.assetId) previousAssets.set(String(record.assetId), record);
        store.delete(key(record));
      });
      pendingReads -= 1;
      if (pendingReads === 0) writeRecords();
    };
  });
}

function deleteObjectCells(transaction, workspaceId, objectId, object) {
  if (!object?.cells) return;
  const chunks = transaction.objectStore(STORE_NAMES.cellChunks);
  const chunkIds = new Set();
  Object.entries(object.cells).forEach(([fallbackCellId, cell]) => {
    chunkIds.add(cellChunkId(cell, fallbackCellId));
  });
  chunkIds.forEach((chunkId) => chunks.delete(cellChunkKey(workspaceId, objectId, chunkId)));
}

function applyObjectOperation(transaction, workspaceId, operation) {
  const objects = transaction.objectStore(STORE_NAMES.objects);
  const key = objectKey(workspaceId, operation.objectId);
  deleteObjectCells(transaction, workspaceId, operation.objectId, operation.before);
  if (!operation.after) {
    objects.delete(key);
    return;
  }
  objects.put(objectStoreRecord(workspaceId, operation.after));
  if (operation.after.type === "sheet" && operation.after.cells) {
    const chunks = transaction.objectStore(STORE_NAMES.cellChunks);
    chunkedCellRecords(workspaceId, operation.objectId, operation.after.cells).forEach((record) => {
      chunks.put(record);
    });
  }
}

function applyCellOperations(transaction, workspaceId, operations) {
  const chunks = transaction.objectStore(STORE_NAMES.cellChunks);
  const grouped = new Map();
  operations.forEach((operation) => {
    const chunkId = cellChunkId(operation.after || operation.before, operation.cellId);
    const groupKey = `${String(operation.objectId)}\u0000${chunkId}`;
    const group = grouped.get(groupKey) || { objectId: String(operation.objectId), chunkId, operations: [] };
    group.operations.push(operation);
    grouped.set(groupKey, group);
  });
  grouped.forEach(({ objectId, chunkId, operations: chunkOperations }) => {
    const key = cellChunkKey(workspaceId, objectId, chunkId);
    const read = chunks.get(key);
    read.onsuccess = () => {
      const nextCells = { ...cellsFromChunkRecord(read.result) };
      chunkOperations.forEach((operation) => {
        if (operation.after) nextCells[String(operation.cellId)] = operation.after;
        else delete nextCells[String(operation.cellId)];
      });
      if (Object.keys(nextCells).length) {
        chunks.put(cellChunkRecord(workspaceId, objectId, chunkId, nextCells));
      } else {
        chunks.delete(key);
      }
    };
  });
}

function applyAssetOperation(transaction, workspaceId, operation) {
  const store = transaction.objectStore(STORE_NAMES.assets);
  const key = assetKey(workspaceId, operation.assetId);
  if (!operation.after) {
    store.delete(key);
    return;
  }
  const read = store.get(key);
  read.onsuccess = () => {
    const previous = read.result;
    const next = assetStoreRecord(workspaceId, operation.assetId, operation.after);
    if (previous?.blob && !next.blob) next.blob = previous.blob;
    store.put(next);
  };
}

function applyPatchOperations(transaction, workspaceId, operations) {
  const cellOperations = operations.filter((operation) => operation.kind === "replace-cell");
  operations.forEach((operation) => {
    switch (operation.kind) {
      case "replace-workspace-meta":
        transaction.objectStore(STORE_NAMES.workspaceMeta).put({
          ...workspaceMetaRecord(operation.after, null),
          workspaceId,
        });
        break;
      case "replace-object":
        applyObjectOperation(transaction, workspaceId, operation);
        break;
      case "replace-cell": {
        break;
      }
      case "replace-asset":
        applyAssetOperation(transaction, workspaceId, operation);
        break;
      case "replace-theme": {
        const store = transaction.objectStore(STORE_NAMES.themes);
        const key = themeKey(workspaceId, operation.themeId);
        if (operation.after) store.put(themeStoreRecord(workspaceId, operation.after));
        else store.delete(key);
        break;
      }
      default:
        throw new Error(`Unsupported persistence operation: ${String(operation.kind)}`);
    }
  });
  applyCellOperations(transaction, workspaceId, cellOperations);
}

function acknowledge(transaction, workspaceId, revision) {
  const store = transaction.objectStore(STORE_NAMES.workspaceMeta);
  const read = store.get(workspaceKey(workspaceId));
  read.onsuccess = () => {
    const current = read.result || { workspaceId };
    store.put({
      ...current,
      workspaceId,
      acknowledgedRevision: String(revision),
      storageState: "active",
      persistedAt: now(),
    });
  };
}

async function recordsForWorkspace(database, workspaceId, { includeStaged = true } = {}) {
  const [metaRecords, objectRecords, cellRecords, cellChunkRecords, assetRecords, themeRecords] = await Promise.all([
    readAllRecords(database, STORE_NAMES.workspaceMeta),
    readAllRecords(database, STORE_NAMES.objects),
    readAllRecords(database, STORE_NAMES.cells),
    readAllRecords(database, STORE_NAMES.cellChunks),
    readAllRecords(database, STORE_NAMES.assets),
    readAllRecords(database, STORE_NAMES.themes),
  ]);
  return {
    meta: metaRecords.find((record) => (
      record.workspaceId === String(workspaceId)
      && (includeStaged || record.storageState !== "staged")
    )) || null,
    objects: objectRecords.filter((record) => record.workspaceId === String(workspaceId)),
    cells: cellRecords.filter((record) => record.workspaceId === String(workspaceId)),
    cellChunks: cellChunkRecords.filter((record) => record.workspaceId === String(workspaceId)),
    assets: assetRecords.filter((record) => record.workspaceId === String(workspaceId)),
    themes: themeRecords.filter((record) => record.workspaceId === String(workspaceId)),
  };
}

function snapshotFromRecords(records) {
  if (!records.meta) return null;
  const workspace = workspaceMetaFromRecord(records.meta);
  workspace.objects = {};
  records.objects.forEach((record) => {
    workspace.objects[record.objectId] = { ...objectFromRecord(record) };
  });
  records.cells.forEach((record) => {
    const object = workspace.objects[record.objectId];
    if (!object) return;
    object.cells ||= {};
    object.cells[record.cellId] = cellFromRecord(record);
  });
  records.cellChunks.forEach((record) => {
    const object = workspace.objects[record.objectId];
    if (!object) return;
    object.cells ||= {};
    Object.assign(object.cells, cellsFromChunkRecord(record));
  });
  records.assets.forEach((record) => {
    workspace.assets ||= {};
    workspace.assets[record.assetId] = assetFromRecord(record);
  });
  records.themes.forEach((record) => {
    workspace.themes ||= {};
    workspace.themes[record.themeId] = themeFromRecord(record);
  });
  return normalizeWorkspace(workspace);
}

async function dataUrlAssets(workspace, readAssetBlob) {
  const assets = {};
  for (const [assetId, asset] of Object.entries(workspace.assets || {})) {
    const blob = await readAssetBlob(assetId);
    assets[assetId] = blob
      ? { ...asset, dataUrl: await blobToDataUrl(blob, asset.mime) }
      : { ...asset };
  }
  return assets;
}

export class BrowserPersistenceAdapter {
  constructor(options = {}) {
    this.indexedDB = indexedDbFor(options.indexedDB);
    this.localStorage = options.localStorage === undefined
      ? (options.storage || (typeof globalThis !== "undefined" ? globalThis.localStorage : null))
      : options.localStorage;
    this.databaseName = options.databaseName || BROWSER_DATABASE_NAME;
    this.databaseVersion = options.databaseVersion || BROWSER_DATABASE_VERSION;
    this.bootMetadataKey = options.bootMetadataKey || BOOT_METADATA_KEY;
    this.legacyOptions = {
      indexedDB: this.indexedDB,
      localStorage: this.localStorage,
      databaseName: options.legacyDatabaseName || LEGACY_DATABASE_NAME,
      storeName: options.legacyStoreName || LEGACY_STORE_NAME,
      workspaceKey: options.legacyWorkspaceKey || LEGACY_WORKSPACE_KEY,
      cacheKey: options.legacyCacheKey || LEGACY_CACHE_KEY,
    };
    this.autoMigrate = options.autoMigrate !== false;
    this.assetUrls = options.assetUrlRegistry || new AssetUrlRegistry(options);
    this.database = null;
    this.databasePromise = null;
    this.workspaceId = options.workspaceId || null;
    this.latestAcknowledgedRevision = null;
    this.migrationError = null;
    this.legacyCellWorkspaceIds = new Set();
  }

  get activeWorkspaceId() {
    return this.workspaceId;
  }

  get acknowledgedRevision() {
    return this.latestAcknowledgedRevision;
  }

  async databaseHandle() {
    if (!this.databasePromise) {
      this.databasePromise = openRecordDatabase({
        indexedDB: this.indexedDB,
        databaseName: this.databaseName,
        version: this.databaseVersion,
      }).then((database) => {
        this.database = database;
        return database;
      });
    }
    return this.databasePromise;
  }

  async open(request = {}) {
    const boot = readBootMetadata(this.localStorage, this.bootMetadataKey);
    this.latestAcknowledgedRevision = boot?.acknowledgedRevision === null || boot?.acknowledgedRevision === undefined
      ? null
      : String(boot.acknowledgedRevision);
    let workspaceId = request.workspaceId || boot?.activeWorkspaceId || this.workspaceId;
    let snapshot = workspaceId && this.indexedDB
      ? await this.readSnapshot(workspaceId, { includeStaged: false })
      : null;

    if (!snapshot && this.autoMigrate) {
      try {
        const migration = await migrateLegacyWorkspace({
          adapter: this,
          indexedDB: this.indexedDB,
          localStorage: this.localStorage,
          legacyOptions: this.legacyOptions,
        });
        if (migration) {
          snapshot = migration.workspace;
          workspaceId = snapshot.id;
        }
      } catch (error) {
        this.migrationError = error;
        const legacy = await readLegacyWorkspace(this.legacyOptions).catch(() => null);
        if (legacy) {
          snapshot = normalizeWorkspace(legacy.workspace);
          workspaceId = snapshot.id;
        }
      }
    }

    if (!snapshot && this.indexedDB) {
      const database = await this.databaseHandle();
      const metas = await readAllRecords(database, STORE_NAMES.workspaceMeta);
      const candidate = metas
        .filter((meta) => meta?.workspaceId && meta.storageState !== "staged")
        .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0];
      if (candidate) {
        workspaceId = candidate.workspaceId;
        snapshot = await this.readSnapshot(workspaceId);
      }
    }

    snapshot ||= createBlankWorkspace();
    this.workspaceId = String(workspaceId || snapshot.id);
    if (this.legacyCellWorkspaceIds.has(this.workspaceId)) {
      await this.writeSnapshot(snapshot, {
        revision: this.latestAcknowledgedRevision || "cell-chunks-v2",
        activate: true,
      });
    }
    return snapshot;
  }

  async readSnapshot(workspaceId = this.workspaceId, options = {}) {
    if (!this.indexedDB || !workspaceId) return null;
    const database = await this.databaseHandle();
    const records = await recordsForWorkspace(database, workspaceId, options);
    if (records.cells.length) this.legacyCellWorkspaceIds.add(String(workspaceId));
    return snapshotFromRecords(records);
  }

  async writeSnapshot(workspace, { revision = "snapshot", activate = false } = {}) {
    if (!this.indexedDB) throw new Error("IndexedDB is unavailable.");
    const normalized = normalizeWorkspace(workspace);
    const database = await this.databaseHandle();
    await runRecordTransaction(database, "readwrite", (transaction) => {
      putWorkspaceRecords(transaction, normalized, revision, activate ? "active" : "staged");
    });
    this.legacyCellWorkspaceIds.delete(String(normalized.id));
    if (activate) await this.activateWorkspace(normalized.id, revision);
    this.workspaceId = normalized.id;
    return normalized;
  }

  async activateWorkspace(workspaceId, revision = null) {
    this.workspaceId = String(workspaceId);
    if (this.indexedDB) {
      const database = await this.databaseHandle();
      await runRecordTransaction(database, "readwrite", (transaction) => {
        const store = transaction.objectStore(STORE_NAMES.workspaceMeta);
        const read = store.get(workspaceKey(this.workspaceId));
        read.onsuccess = () => {
          const current = read.result || { workspaceId: this.workspaceId };
          store.put({
            ...current,
            workspaceId: this.workspaceId,
            ...(revision ? { acknowledgedRevision: String(revision) } : {}),
            storageState: "active",
          });
        };
      }, [STORE_NAMES.workspaceMeta]);
    }
    writeBootMetadata({
      activeWorkspaceId: this.workspaceId,
      acknowledgedRevision: revision,
      databaseName: this.databaseName,
    }, this.localStorage, this.bootMetadataKey);
    this.latestAcknowledgedRevision = revision === null || revision === undefined ? null : String(revision);
  }

  async commit(persisted) {
    if (!this.indexedDB) throw new Error("IndexedDB is unavailable.");
    if (!this.workspaceId) throw new Error("Open a workspace before committing a transaction.");
    const transactionResult = persisted?.transaction;
    const revision = String(persisted?.revision || transactionResult?.revision || "");
    if (!revision) throw new Error("A persistence commit requires a revision.");
    const database = await this.databaseHandle();
    await runRecordTransaction(database, "readwrite", (transaction) => {
      applyPatchOperations(transaction, this.workspaceId, transactionResult?.forwardPatch?.operations || []);
      acknowledge(transaction, this.workspaceId, revision);
    });
    writeBootMetadata({
      activeWorkspaceId: this.workspaceId,
      acknowledgedRevision: revision,
      databaseName: this.databaseName,
    }, this.localStorage, this.bootMetadataKey);
    this.latestAcknowledgedRevision = String(revision);
    const acknowledgement = {
      revision,
      persistedAt: now(),
      dirtyRecordIds: [...new Set((transactionResult?.dirtyRecords || []).map((record) => String(record.recordId)))],
    };
    return acknowledgement;
  }

  async checkpoint(revision) {
    if (!this.workspaceId) return;
    writeBootMetadata({
      activeWorkspaceId: this.workspaceId,
      acknowledgedRevision: String(revision),
      databaseName: this.databaseName,
    }, this.localStorage, this.bootMetadataKey);
    this.latestAcknowledgedRevision = String(revision);
  }

  async readAssetBlob(assetId, workspaceId = this.workspaceId) {
    if (!this.indexedDB || !workspaceId) return null;
    const database = await this.databaseHandle();
    const record = await readRecord(database, STORE_NAMES.assets, assetKey(workspaceId, assetId));
    return record?.blob || null;
  }

  async readAsset({ assetId }) {
    const blob = await this.readAssetBlob(assetId);
    if (!blob) throw new Error(`Asset ${String(assetId)} is unavailable.`);
    return {
      assetId,
      mime: blob.type || undefined,
      data: new Uint8Array(await blob.arrayBuffer()),
    };
  }

  async writeAsset({ record, data }) {
    if (!this.indexedDB) throw new Error("IndexedDB is unavailable.");
    if (!this.workspaceId) throw new Error("Open a workspace before writing an asset.");
    const assetId = idFromRecord(record, record?.assetId);
    if (!assetId) throw new Error("An asset write requires an asset id.");
    const blob = toNativeBlob(data, record?.mime);
    if (!blob) throw new Error(`Asset ${assetId} has no binary data.`);
    const database = await this.databaseHandle();
    await runRecordTransaction(database, "readwrite", (transaction) => {
      transaction.objectStore(STORE_NAMES.assets).put(assetRecord(
        this.workspaceId,
        assetId,
        { ...record, size: record?.size ?? blob.size, mime: record?.mime || blob.type },
        blob,
      ));
    }, [STORE_NAMES.assets]);
    return { ...record, id: assetId, size: record?.size ?? blob.size, mime: record?.mime || blob.type };
  }

  async acquireAssetUrl(assetId) {
    const blob = await this.readAssetBlob(assetId);
    return this.assetUrls.acquire(assetId, blob);
  }

  releaseAssetUrl(assetId, url) {
    return this.assetUrls.release(assetId, url);
  }

  async acquireAssetHandle(assetId) {
    const lease = await this.acquireAssetUrl(assetId);
    const blob = await this.readAssetBlob(assetId);
    return {
      assetId: String(assetId),
      handle: lease.url,
      ...(blob?.type ? { mime: blob.type } : {}),
      ...(blob?.size === undefined ? {} : { size: blob.size }),
      release: async () => {
        lease.release();
      },
    };
  }

  releaseAssetHandle(handle) {
    return this.releaseAssetUrl(handle.assetId, handle.handle);
  }

  async importPortable(source) {
    let workspace;
    if (source?.kind === "json") workspace = normalizeWorkspace(JSON.parse(source.data));
    else if (source?.kind === "zip") workspace = (await readPortableV4Package(source.data)).workspace;
    else throw new Error("Unsupported portable import source.");
    await this.writeSnapshot(workspace, { revision: `import-${Date.now().toString(36)}`, activate: true });
    return this.readSnapshot(workspace.id);
  }

  async exportPortable(request = {}) {
    const workspace = await this.readSnapshot(request.workspaceId || this.workspaceId);
    if (!workspace) throw new Error("The requested workspace is unavailable.");
    const assets = await dataUrlAssets(workspace, (assetId) => this.readAssetBlob(assetId, workspace.id));
    const withAssets = { ...workspace, assets };
    if (request.format === "zip") {
      const packageData = buildPortableV4Package(withAssets);
      return {
        format: "zip",
        fileName: `${workspace.name || "tactile"}.zip`,
        mime: "application/zip",
        data: await portablePackageToZip(packageData),
      };
    }
    const packageData = buildPortablePackage(withAssets);
    return {
      format: "json",
      fileName: `${workspace.name || "tactile"}.tactile.json`,
      mime: "application/json",
      data: JSON.stringify({ ...withAssets, version: 4, format: "tactile" }, null, 2),
      package: packageData,
    };
  }

  async close() {
    this.assetUrls.clear();
    this.database?.close();
    this.database = null;
    this.databasePromise = null;
    this.workspaceId = null;
    this.latestAcknowledgedRevision = null;
  }
}

export function createBrowserPersistence(options = {}) {
  return new BrowserPersistenceAdapter(options);
}

export const BrowserPersistence = BrowserPersistenceAdapter;
