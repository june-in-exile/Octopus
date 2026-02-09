/**
 * IndexedDB cache for note scanning results
 * Implements Solution 2: Local Cache + Incremental Scanning
 */

export interface CachedScanData {
  // User identifier (hash based on spendingKey)
  userKey: string;

  // Pool identifier
  poolId: string;

  // Last scanned position
  lastScannedCursor: string | null; // GraphQL endCursor
  lastScannedTimestamp: number;

  // Scanned notes (pathElements removed - computed lazily at transaction time)
  ownedNotes: Array<{
    note: {
      nsk: string;
      token: string;
      value: string;
      random: string;
      commitment: string;
    };
    leafIndex: number;
    nullifier: string;
    txDigest: string;
  }>;

  // Merkle tree state
  allCommitments: Array<{
    commitment: string;
    leafIndex: number;
  }>;

  // Statistics
  totalNotesInPool: number;
  lastScanDuration: number;
}

const DB_NAME = 'octopus-notes-cache';
const DB_VERSION = 2; // Bumped: removed pathElements from ownedNotes
const STORE_NAME = 'scan-cache';

/**
 * Open IndexedDB database
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    console.log('[notesCache] Opening IndexedDB:', DB_NAME, 'version:', DB_VERSION);
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      console.log('[notesCache] Database upgrade needed');
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        console.log('[notesCache] Creating object store:', STORE_NAME);
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: ['userKey', 'poolId'],
        });
        store.createIndex('timestamp', 'lastScannedTimestamp');
      }
    };

    request.onsuccess = () => {
      console.log('[notesCache] Database opened successfully');
      resolve(request.result);
    };
    request.onerror = () => {
      console.error('[notesCache] Error opening database:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Save scan cache to IndexedDB
 */
export async function saveScanCache(data: CachedScanData): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.put(data);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Load scan cache from IndexedDB
 */
export async function loadScanCache(
  userKey: string,
  poolId: string
): Promise<CachedScanData | null> {
  console.log('[notesCache] loadScanCache called. userKey:', userKey, 'poolId:', poolId);
  console.log('[notesCache] Opening database...');
  const startDb = Date.now();
  const db = await openDatabase();
  console.log('[notesCache] Database opened in', Date.now() - startDb, 'ms');

  console.log('[notesCache] Creating transaction...');
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);

  return new Promise((resolve, reject) => {
    console.log('[notesCache] Getting data from store...');
    const startGet = Date.now();
    const request = store.get([userKey, poolId]);
    request.onsuccess = () => {
      console.log('[notesCache] Data retrieved in', Date.now() - startGet, 'ms. Result:', !!request.result);
      if (request.result) {
        console.log('[notesCache] Cache data size - notes:', request.result.ownedNotes?.length, 'commitments:', request.result.allCommitments?.length);
      }
      resolve(request.result || null);
    };
    request.onerror = () => {
      console.error('[notesCache] Error loading cache:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Clear scan cache
 * @param userKey - Optional user key to clear specific user's cache
 * @param poolId - Optional pool ID to clear specific pool's cache
 */
export async function clearScanCache(
  userKey?: string,
  poolId?: string
): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  return new Promise((resolve, reject) => {
    let request: IDBRequest;

    if (userKey && poolId) {
      request = store.delete([userKey, poolId]);
    } else {
      request = store.clear();
    }

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Generate cache key from spending key
 * Uses SHA-256 hash to create a deterministic user identifier
 */
export async function generateCacheKey(spendingKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(spendingKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
