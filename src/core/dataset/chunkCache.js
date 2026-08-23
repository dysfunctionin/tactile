/**
 * Bounded residency for the 64x64 cell blocks.
 *
 * A virtual sheet keeps only the blocks it is working on. Eviction is by least
 * recent use and measured in bytes, because block cost varies by an order of
 * magnitude between a sparse block and a full one.
 *
 * Invalidation marks a block stale instead of dropping it. The previous values
 * stay readable and render dimmed while the refresh is in flight, which is what
 * keeps a scroll from flashing empty on every revision.
 */

export const DEFAULT_CHUNK_CACHE_BYTES = 32 * 1024 * 1024;

function estimateBytes(cells) {
  let bytes = 64;
  for (const [cellId, cell] of Object.entries(cells)) {
    bytes += 48 + cellId.length * 2;
    if (!cell || typeof cell !== "object") continue;
    for (const [key, value] of Object.entries(cell)) {
      bytes += 16 + key.length * 2;
      bytes += typeof value === "string" ? value.length * 2 : 8;
    }
  }
  return bytes;
}

export function chunkCacheKey(objectId, chunkKey) {
  return `${objectId}\u0000${chunkKey}`;
}

export function createChunkCache({ maxBytes = DEFAULT_CHUNK_CACHE_BYTES } = {}) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive number.");
  }
  // Map iterates in insertion order, so deleting and re-inserting on access
  // makes the first key the least recently used one.
  const entries = new Map();
  const pinned = new Set();
  let bytes = 0;
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  function touch(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
  }

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return;
    bytes -= entry.bytes;
    entries.delete(key);
  }

  function evictToFit() {
    for (const [key, entry] of entries) {
      if (bytes <= maxBytes) return;
      // A pinned block belongs to the visible window; evicting it would make
      // the sheet re-fetch what it is currently painting.
      if (pinned.has(key)) continue;
      bytes -= entry.bytes;
      entries.delete(key);
      evictions += 1;
    }
  }

  return {
    get(objectId, chunkKey) {
      const key = chunkCacheKey(objectId, chunkKey);
      const entry = entries.get(key);
      if (!entry) {
        misses += 1;
        return null;
      }
      hits += 1;
      touch(key, entry);
      return entry;
    },

    has(objectId, chunkKey) {
      return entries.has(chunkCacheKey(objectId, chunkKey));
    },

    set(objectId, chunkKey, cells) {
      const key = chunkCacheKey(objectId, chunkKey);
      remove(key);
      const entry = { cells, bytes: estimateBytes(cells), state: "ready" };
      entries.set(key, entry);
      bytes += entry.bytes;
      evictToFit();
      return entry;
    },

    /** Keeps the values readable so the sheet can dim them rather than blank them. */
    invalidate(objectId, chunkKey) {
      const entry = entries.get(chunkCacheKey(objectId, chunkKey));
      if (entry) entry.state = "stale";
    },

    invalidateObject(objectId) {
      const prefix = `${objectId}\u0000`;
      for (const [key, entry] of entries) {
        if (key.startsWith(prefix)) entry.state = "stale";
      }
    },

    delete(objectId, chunkKey) {
      remove(chunkCacheKey(objectId, chunkKey));
    },

    dropObject(objectId) {
      const prefix = `${objectId}\u0000`;
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) remove(key);
      }
    },

    pin(objectId, chunkKeys) {
      pinned.clear();
      for (const chunkKey of chunkKeys) pinned.add(chunkCacheKey(objectId, chunkKey));
    },

    clear() {
      entries.clear();
      pinned.clear();
      bytes = 0;
    },

    metrics() {
      return { entries: entries.size, bytes, maxBytes, pinned: pinned.size, hits, misses, evictions };
    },
  };
}
