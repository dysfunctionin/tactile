//! Native cell-chunk store.
//!
//! Sheets persist as fixed 64x64 blocks of cells (ADR 0002). This module is the
//! native backing for those blocks: the webview asks for the blocks it is about
//! to render and Rust reads only those rows, so opening a large workspace never
//! costs a full-sheet materialization.
//!
//! Only chunk payloads cross the IPC boundary. Database paths, SQL, and the
//! record-key layout stay inside this module.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use super::error::StorageError;
use super::sqlite::SqliteStorage;

const CHUNK_TABLE: &str = "cell-chunk";
const CACHE_DIRECTORY: &str = "chunk-cache";

/// One 64x64 block of cells, keyed the same way on every backend.
///
/// `cells` is carried as an opaque JSON string: chunk contents are the
/// webview's data model, and re-encoding it here would fork the format.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkPayload {
    pub chunk_key: String,
    pub cells: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkWrite {
    #[serde(default)]
    pub put: Vec<ChunkPayload>,
    #[serde(default)]
    pub delete: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkStoreStatus {
    pub schema_version: u32,
    pub revision: u64,
    pub chunk_count: usize,
}

/// One open database per workspace, held for the life of the process.
#[derive(Default)]
pub struct ChunkStoreState {
    stores: Mutex<HashMap<String, SqliteStorage>>,
}

fn identifier(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is required"));
    }
    // Keys are joined with a separator, so a separator inside a component
    // would let one object's prefix scan reach into another's rows.
    if trimmed.contains('\u{0}') || trimmed.contains('/') {
        return Err(format!("{label} contains an unsupported character"));
    }
    Ok(trimmed.to_owned())
}

fn object_prefix(workspace_id: &str, object_id: &str) -> String {
    format!("{workspace_id}/{object_id}/")
}

fn record_key(workspace_id: &str, object_id: &str, chunk_key: &str) -> String {
    format!("{}{}", object_prefix(workspace_id, object_id), chunk_key)
}

fn cache_root(app: &AppHandle, workspace_id: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| "the application data directory is unavailable".to_owned())?;
    // Workspace ids are opaque to the filesystem, so the directory is a hash
    // rather than the id itself.
    Ok(base.join(CACHE_DIRECTORY).join(digest(workspace_id)))
}

/// FNV-1a. A filename only needs to be stable and collision-resistant enough
/// to separate workspaces, not cryptographically strong.
fn digest(value: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn describe(error: StorageError) -> String {
    error.to_string()
}

fn with_store<T>(
    app: &AppHandle,
    state: &State<'_, ChunkStoreState>,
    workspace_id: &str,
    action: impl FnOnce(&mut SqliteStorage) -> Result<T, String>,
) -> Result<T, String> {
    let mut stores = state
        .stores
        .lock()
        .map_err(|_| "the chunk store is unavailable".to_owned())?;
    if !stores.contains_key(workspace_id) {
        let root = cache_root(app, workspace_id)?;
        let store = SqliteStorage::open(&root).map_err(describe)?;
        stores.insert(workspace_id.to_owned(), store);
    }
    let store = stores
        .get_mut(workspace_id)
        .ok_or_else(|| "the chunk store is unavailable".to_owned())?;
    action(store)
}

#[tauri::command]
pub fn chunk_store_status(
    app: AppHandle,
    state: State<'_, ChunkStoreState>,
    workspace_id: String,
) -> Result<ChunkStoreStatus, String> {
    let workspace_id = identifier(&workspace_id, "workspaceId")?;
    with_store(&app, &state, &workspace_id, |store| {
        let chunk_count = store
            .keys_with_prefix(CHUNK_TABLE, &format!("{workspace_id}/"))
            .map_err(describe)?
            .len();
        Ok(ChunkStoreStatus {
            schema_version: store.schema_version(),
            revision: store.revision(),
            chunk_count,
        })
    })
}

/// Reads only the requested blocks. A key with no row is omitted rather than
/// returned empty, so the caller can tell "never written" from "written empty".
#[tauri::command]
pub fn chunk_store_read(
    app: AppHandle,
    state: State<'_, ChunkStoreState>,
    workspace_id: String,
    object_id: String,
    chunk_keys: Vec<String>,
) -> Result<Vec<ChunkPayload>, String> {
    let workspace_id = identifier(&workspace_id, "workspaceId")?;
    let object_id = identifier(&object_id, "objectId")?;
    with_store(&app, &state, &workspace_id, |store| {
        let mut payloads = Vec::with_capacity(chunk_keys.len());
        for chunk_key in &chunk_keys {
            let chunk_key = identifier(chunk_key, "chunkKey")?;
            let key = record_key(&workspace_id, &object_id, &chunk_key);
            let Some(bytes) = store.get(CHUNK_TABLE, &key).map_err(describe)? else {
                continue;
            };
            let cells =
                String::from_utf8(bytes).map_err(|_| "a stored chunk is corrupt".to_owned())?;
            payloads.push(ChunkPayload { chunk_key, cells });
        }
        Ok(payloads)
    })
}

#[tauri::command]
pub fn chunk_store_list(
    app: AppHandle,
    state: State<'_, ChunkStoreState>,
    workspace_id: String,
    object_id: String,
) -> Result<Vec<String>, String> {
    let workspace_id = identifier(&workspace_id, "workspaceId")?;
    let object_id = identifier(&object_id, "objectId")?;
    with_store(&app, &state, &workspace_id, |store| {
        let prefix = object_prefix(&workspace_id, &object_id);
        let keys = store
            .keys_with_prefix(CHUNK_TABLE, &prefix)
            .map_err(describe)?;
        Ok(keys
            .into_iter()
            .filter_map(|key| key.strip_prefix(&prefix).map(str::to_owned))
            .collect())
    })
}

/// Applies puts and deletes as one transaction, so a batch of edited blocks is
/// durable together or not at all.
#[tauri::command]
pub fn chunk_store_write(
    app: AppHandle,
    state: State<'_, ChunkStoreState>,
    workspace_id: String,
    object_id: String,
    write: ChunkWrite,
) -> Result<u64, String> {
    let workspace_id = identifier(&workspace_id, "workspaceId")?;
    let object_id = identifier(&object_id, "objectId")?;
    with_store(&app, &state, &workspace_id, |store| {
        let mut transaction = store.begin_transaction();
        for payload in &write.put {
            let chunk_key = identifier(&payload.chunk_key, "chunkKey")?;
            transaction
                .put(
                    CHUNK_TABLE,
                    record_key(&workspace_id, &object_id, &chunk_key),
                    payload.cells.as_bytes().to_vec(),
                )
                .map_err(describe)?;
        }
        for chunk_key in &write.delete {
            let chunk_key = identifier(chunk_key, "chunkKey")?;
            transaction
                .delete(
                    CHUNK_TABLE,
                    record_key(&workspace_id, &object_id, &chunk_key),
                )
                .map_err(describe)?;
        }
        if transaction.is_empty() {
            return Ok(store.revision());
        }
        let receipt = store.commit(transaction).map_err(describe)?;
        Ok(receipt.revision)
    })
}

#[tauri::command]
pub fn chunk_store_drop_object(
    app: AppHandle,
    state: State<'_, ChunkStoreState>,
    workspace_id: String,
    object_id: String,
) -> Result<u64, String> {
    let workspace_id = identifier(&workspace_id, "workspaceId")?;
    let object_id = identifier(&object_id, "objectId")?;
    with_store(&app, &state, &workspace_id, |store| {
        let prefix = object_prefix(&workspace_id, &object_id);
        let keys = store
            .keys_with_prefix(CHUNK_TABLE, &prefix)
            .map_err(describe)?;
        if keys.is_empty() {
            return Ok(store.revision());
        }
        let mut transaction = store.begin_transaction();
        for key in keys {
            transaction.delete(CHUNK_TABLE, key).map_err(describe)?;
        }
        let receipt = store.commit(transaction).map_err(describe)?;
        Ok(receipt.revision)
    })
}
