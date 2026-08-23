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
  cellChunkKey,
  cellChunkRecord,
  cellFromRecord,
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
  hasWorkspaceRecords,
  indexedDbFor,
  objectKeyRange,
  openRecordDatabase,
  readAllRecords,
  readRecord,
  readWorkspaceRecords,
  runRecordTransaction,
  workspaceKeyRange,
} from "./indexedDb.js";
import { chunkKeyForCellId, groupCellsIntoChunks } from "../../core/dataset/cellChunks.js";
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

function putWorkspaceRecords(transaction, workspace, revision, storageState = "active") {
  const workspaceId = String(workspace.id);
  const range = workspaceKeyRange(workspaceId);
  const metaStore = transaction.objectStore(STORE_NAMES.workspaceMeta);
  const objectStore = transaction.objectStore(STORE_NAMES.objects);
  const cellStore = transaction.objectStore(STORE_NAMES.cells);
  const chunkStore = transaction.objectStore(STORE_NAMES.cellChunks);
  const assetStore = transaction.objectStore(STORE_NAMES.assets);
  const themeStore = transaction.objectStore(STORE_NAMES.themes);

  // Assets are the only store whose previous rows are still needed: the caller
  // can hand back metadata without the blob it was saved with. Everything else
  // is replaced wholesale by one range delete rather than a row-by-row sweep.
  const previousAssets = new Map();
  const readAssets = assetStore.getAll(range);

  objectStore.delete(range);
  cellStore.delete(range);
  chunkStore.delete(range);
  themeStore.delete(range);

  readAssets.onsuccess = () => {
    (readAssets.result || []).forEach((record) => {
      if (record.assetId) previousAssets.set(String(record.assetId), record);
    });
    assetStore.delete(range);

    metaStore.put(workspaceMetaRecord(workspace, revision, storageState));
    Object.values(workspace.objects || {}).forEach((object) => {
      objectStore.put(objectStoreRecord(workspaceId, object));
      groupCellsIntoChunks(object.cells).forEach((chunk) => {
        chunkStore.put(cellChunkRecord(workspaceId, object.id, chunk.chunkKey, chunk.cells));
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
}

// Cell edits are buffered per chunk and flushed once, so a paste that touches
// thousands of cells costs one read-modify-write per 64x64 block, not per cell.
function createChunkWriter(transaction, workspaceId) {
  const store = transaction.objectStore(STORE_NAMES.cellChunks);
  const pending = new Map();

  const edit = (objectId, cellId, cell) => {
    const chunk = chunkKeyForCellId(cellId);
    const key = `${objectId}\u0000${chunk}`;
    let entry = pending.get(key);
    if (!entry) {
      entry = { objectId: String(objectId), chunkKey: chunk, edits: new Map() };
      pending.set(key, entry);
    }
    entry.edits.set(String(cellId), cell);
  };

  // A whole-object rewrite supersedes anything buffered for that object.
  const dropObject = (objectId) => {
    for (const [key, entry] of pending) {
      if (entry.objectId === String(objectId)) pending.delete(key);
    }
  };

  const flush = () => {
    for (const entry of pending.values()) {
      const key = cellChunkKey(workspaceId, entry.objectId, entry.chunkKey);
      const read = store.get(key);
      read.onsuccess = () => {
        const cells = { ...(read.result?.cells || {}) };
        entry.edits.forEach((cell, cellId) => {
          if (cell) cells[cellId] = cell;
          else delete cells[cellId];
        });
        if (Object.keys(cells).length === 0) store.delete(key);
        else store.put(cellChunkRecord(workspaceId, entry.objectId, entry.chunkKey, cells));
      };
    }
    pending.clear();
  };

  return { edit, dropObject, flush };
}

function deleteObjectCells(transaction, workspaceId, objectId) {
  transaction.objectStore(STORE_NAMES.cells).delete(objectKeyRange(workspaceId, objectId));
  transaction.objectStore(STORE_NAMES.cellChunks).delete(objectKeyRange(workspaceId, objectId));
}

function applyObjectOperation(transaction, workspaceId, operation) {
  const objects = transaction.objectStore(STORE_NAMES.objects);
  const chunks = transaction.objectStore(STORE_NAMES.cellChunks);
  const key = objectKey(workspaceId, operation.objectId);
  deleteObjectCells(transaction, workspaceId, operation.objectId);
  if (!operation.after) {
    objects.delete(key);
    return;
  }
  objects.put(objectStoreRecord(workspaceId, operation.after));
  if (operation.after.type === "sheet" && operation.after.cells) {
    groupCellsIntoChunks(operation.after.cells).forEach((chunk) => {
      chunks.put(cellChunkRecord(workspaceId, operation.objectId, chunk.chunkKey, chunk.cells));
    });
  }
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
  const chunkWriter = createChunkWriter(transaction, workspaceId);
  operations.forEach((operation) => {
    switch (operation.kind) {
      case "replace-workspace-meta":
        transaction.objectStore(STORE_NAMES.workspaceMeta).put({
          ...workspaceMetaRecord(operation.after, null),
          workspaceId,
        });
        break;
      case "replace-object":
        chunkWriter.dropObject(operation.objectId);
        applyObjectOperation(transaction, workspaceId, operation);
        break;
      case "replace-cell":
        chunkWriter.edit(operation.objectId, operation.cellId, operation.after || null);
        break;
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
  chunkWriter.flush();
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
  const id = String(workspaceId);
  const [meta, objectRecords, chunkRecords, assetRecords, themeRecords] = await Promise.all([
    readRecord(database, STORE_NAMES.workspaceMeta, workspaceKey(id)),
    readWorkspaceRecords(database, STORE_NAMES.objects, id),
    readWorkspaceRecords(database, STORE_NAMES.cellChunks, id),
    readWorkspaceRecords(database, STORE_NAMES.assets, id),
    readWorkspaceRecords(database, STORE_NAMES.themes, id),
  ]);
  // A workspace written by v1 has per-cell rows and no chunks. Reading both and
  // letting chunks win keeps it correct until `migrateCellChunks` rewrites it.
  const cellRecords = await readWorkspaceRecords(database, STORE_NAMES.cells, id);
  return {
    meta: meta && (includeStaged || meta.storageState !== "staged") ? meta : null,
    objects: objectRecords,
    chunks: chunkRecords,
    cells: cellRecords,
    assets: assetRecords,
    themes: themeRecords,
    chunked: cellRecords.length === 0,
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
  records.chunks.forEach((record) => {
    const object = workspace.objects[record.objectId];
    if (!object) return;
    object.cells ||= {};
    Object.assign(object.cells, record.cells || {});
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
    this.lastOpenSource = null;
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
    this.lastOpenSource = snapshot ? "records" : null;

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
          this.lastOpenSource = "migration";
        }
      } catch (error) {
        this.migrationError = error;
        const legacy = await readLegacyWorkspace(this.legacyOptions).catch(() => null);
        if (legacy) {
          snapshot = normalizeWorkspace(legacy.workspace);
          workspaceId = snapshot.id;
          this.lastOpenSource = "legacy";
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
        if (snapshot) this.lastOpenSource = "candidate";
      }
    }

    if (!snapshot) {
      snapshot = createBlankWorkspace();
      this.lastOpenSource = "blank";
    }
    this.workspaceId = String(workspaceId || snapshot.id);
    await this.migrateCellChunks(this.workspaceId).catch(() => false);
    return snapshot;
  }

  // v1 stored one row per cell. Rewriting those rows as chunks is what turns a
  // quarter-million writes into a few hundred, so it runs once per workspace.
  async migrateCellChunks(workspaceId = this.workspaceId) {
    if (!this.indexedDB || !workspaceId) return false;
    const database = await this.databaseHandle();
    if (!(await hasWorkspaceRecords(database, STORE_NAMES.cells, workspaceId))) return false;

    const [cellRecords, chunkRecords] = await Promise.all([
      readWorkspaceRecords(database, STORE_NAMES.cells, workspaceId),
      readWorkspaceRecords(database, STORE_NAMES.cellChunks, workspaceId),
    ]);
    const byObject = new Map();
    const cellsFor = (objectId) => {
      let cells = byObject.get(String(objectId));
      if (!cells) {
        cells = {};
        byObject.set(String(objectId), cells);
      }
      return cells;
    };
    cellRecords.forEach((record) => {
      cellsFor(record.objectId)[String(record.cellId)] = cellFromRecord(record);
    });
    // Anything already chunked is newer than the v1 row it shadows.
    chunkRecords.forEach((record) => {
      Object.assign(cellsFor(record.objectId), record.cells || {});
    });

    await runRecordTransaction(database, "readwrite", (transaction) => {
      const chunks = transaction.objectStore(STORE_NAMES.cellChunks);
      byObject.forEach((cells, objectId) => {
        groupCellsIntoChunks(cells).forEach((chunk) => {
          chunks.put(cellChunkRecord(workspaceId, objectId, chunk.chunkKey, chunk.cells));
        });
      });
      transaction.objectStore(STORE_NAMES.cells).delete(workspaceKeyRange(workspaceId));
    }, [STORE_NAMES.cells, STORE_NAMES.cellChunks]);
    return true;
  }

  async readSnapshot(workspaceId = this.workspaceId, options = {}) {
    if (!this.indexedDB || !workspaceId) return null;
    const database = await this.databaseHandle();
    const records = await recordsForWorkspace(database, workspaceId, options);
    return snapshotFromRecords(records);
  }

  async writeSnapshot(workspace, { revision = "snapshot", activate = false } = {}) {
    if (!this.indexedDB) throw new Error("IndexedDB is unavailable.");
    const normalized = normalizeWorkspace(workspace);
    const database = await this.databaseHandle();
    await runRecordTransaction(database, "readwrite", (transaction) => {
      putWorkspaceRecords(transaction, normalized, revision, activate ? "active" : "staged");
    });
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
