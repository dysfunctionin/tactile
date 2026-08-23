import { requireTauriInvoke, type TauriInvoke } from "./runtime.ts";

/** Command names for the native cell-chunk store. */
export const CHUNK_STORE_COMMANDS = Object.freeze({
  status: "chunk_store_status",
  read: "chunk_store_read",
  list: "chunk_store_list",
  write: "chunk_store_write",
  dropObject: "chunk_store_drop_object",
});

export interface ChunkRecord {
  chunkKey: string;
  cells: Record<string, unknown>;
}

export interface NativeChunkStoreOptions {
  invoke?: TauriInvoke;
  runtime?: unknown;
}

interface NativeChunkPayload {
  chunkKey: string;
  cells: string;
}

export class NativeChunkStoreError extends Error {
  readonly command: string;

  constructor(message: string, command: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NativeChunkStoreError";
    this.command = command;
  }
}

function parseCells(value: unknown, chunkKey: string): Record<string, unknown> {
  if (typeof value !== "string") throw new NativeChunkStoreError(`Chunk ${chunkKey} is malformed.`, "chunk_store_read");
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new NativeChunkStoreError(`Chunk ${chunkKey} is malformed.`, "chunk_store_read", { cause });
  }
}

/**
 * Native backing for the 64x64 cell blocks.
 *
 * Rust owns the file I/O and reads only the requested rows out of SQLite, so
 * opening a large sheet costs one query per visible block instead of a full
 * materialization in the webview. Chunk contents cross the boundary as opaque
 * JSON: the shape belongs to the webview and re-encoding it in Rust would fork
 * the format.
 */
export function createNativeChunkStore(workspaceId: string, options: NativeChunkStoreOptions = {}) {
  const invoke = requireTauriInvoke(options.runtime, options.invoke);
  const id = String(workspaceId);
  if (!id) throw new NativeChunkStoreError("A workspace id is required.", CHUNK_STORE_COMMANDS.status);

  async function call(command: string, payload: Record<string, unknown>): Promise<unknown> {
    try {
      return await invoke(command, { workspaceId: id, ...payload });
    } catch (cause) {
      throw new NativeChunkStoreError(String((cause as Error)?.message || cause), command, { cause });
    }
  }

  return {
    async status() {
      return (await call(CHUNK_STORE_COMMANDS.status, {})) as {
        schemaVersion: number;
        revision: number;
        chunkCount: number;
      };
    },

    async readChunks(objectId: string, chunkKeys: readonly string[]): Promise<ChunkRecord[]> {
      if (!chunkKeys.length) return [];
      const response = await call(CHUNK_STORE_COMMANDS.read, {
        objectId: String(objectId),
        chunkKeys: chunkKeys.map(String),
      });
      if (!Array.isArray(response)) {
        throw new NativeChunkStoreError("The chunk read did not return a list.", CHUNK_STORE_COMMANDS.read);
      }
      return (response as NativeChunkPayload[]).map((payload) => ({
        chunkKey: String(payload.chunkKey),
        cells: parseCells(payload.cells, String(payload.chunkKey)),
      }));
    },

    async listChunkKeys(objectId: string): Promise<string[]> {
      const response = await call(CHUNK_STORE_COMMANDS.list, { objectId: String(objectId) });
      return Array.isArray(response) ? response.map(String) : [];
    },

    async writeChunks(
      objectId: string,
      put: readonly ChunkRecord[],
      remove: readonly string[] = [],
    ): Promise<void> {
      if (!put.length && !remove.length) return;
      await call(CHUNK_STORE_COMMANDS.write, {
        objectId: String(objectId),
        write: {
          put: put.map((record) => ({
            chunkKey: String(record.chunkKey),
            cells: JSON.stringify(record.cells ?? {}),
          })),
          delete: remove.map(String),
        },
      });
    },

    async dropObject(objectId: string): Promise<void> {
      await call(CHUNK_STORE_COMMANDS.dropObject, { objectId: String(objectId) });
    },
  };
}
