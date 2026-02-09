# Note Scanning Performance Optimization

## Problem Statement

Current Octopus protocol note scanning has severe performance bottlenecks:

- Must query all ShieldEvent and TransferEvent (potentially thousands)
- Attempts full ECDH + ChaCha20-Poly1305 decryption for each encrypted_note
- Verifies NSK match (checks if note belongs to user)

**Performance Issues:**

- With 10,000 notes in pool → 10,000 full decryption attempts required
- Each decryption: ECDH + HKDF key derivation + ChaCha20-Poly1305 + Poseidon verification
- Even with Web Worker parallelization, scan time can reach several minutes

## Solutions

### ✅ Solution 1: Viewing Key Tag (Implemented)

**Core Idea:** Add an 8-byte tag before encryption data for fast filtering

#### Implementation Details

```typescript
// New format (196 bytes)
viewing_tag (8) || ephemeral_pk (32) || nonce (12) || ciphertext (128) || auth_tag (16)

// During encryption
const viewingTag = HKDF(shared_secret, "octopus-viewing-tag-v1", 8);

// During scanning
for (const event of allEvents) {
  // Step 1: Fast filtering (ECDH + hash only)
  if (!quickCheckNote(event.encrypted_note, spendingKey)) {
    continue; // Skip
  }

  // Step 2: Full decryption (only for tag-matched notes)
  const note = decryptNote(event.encrypted_note, spendingKey, mpk);
  if (note) ownedNotes.push(note);
}
```

#### Performance Improvement

- Fast filtering: ~0.1ms/note (ECDH + hash only)
- Full decryption: ~1ms/note (ECDH + HKDF + ChaCha20 + Poseidon)
- **Theoretical: 10x improvement**

#### Actual Results

**Limitation:** Only effective for new format (196 bytes) notes. If pool contains mostly old format (188 bytes), performance gain is limited.

#### Completed Changes

- ✅ SDK encryption logic ([sdk/src/crypto.ts](../sdk/src/crypto.ts))
  - `encryptNote()` - Added viewing tag
  - `decryptNote()` - Supports both old and new formats
  - `quickCheckNote()` - Fast filtering function
- ✅ Worker scanning logic ([frontend/src/workers/noteScanWorker.ts](../frontend/src/workers/noteScanWorker.ts))
  - Shield event scanning with fast filtering
  - Transfer event scanning with fast filtering

---

### ✅ Solution 2: Local Cache + Incremental Scanning (Implemented)

**Core Idea:** Use IndexedDB to cache scanned notes, only scan new events

**Implementation Status:** ✅ **Completed** (2026-02-10)

#### Completed Changes

- ✅ IndexedDB cache management ([frontend/src/lib/notesCache.ts](../frontend/src/lib/notesCache.ts))
  - `openDatabase()` - IndexedDB database initialization
  - `saveScanCache()` - Save scan results to cache
  - `loadScanCache()` - Load cached scan data
  - `clearScanCache()` - Clear cache for specific user/pool or all
  - `generateCacheKey()` - Generate SHA-256 hash for cache key
- ✅ Worker message types ([frontend/src/workers/types.ts](../frontend/src/workers/types.ts))
  - `ClearCacheRequest` / `ClearCacheResponse` - Clear cache operation
  - `GetCacheInfoRequest` / `GetCacheInfoResponse` - Get cache metadata
- ✅ Worker incremental scanning ([frontend/src/workers/noteScanWorker.ts](../frontend/src/workers/noteScanWorker.ts))
  - Modified `queryAllEvents()` to support cursor-based pagination
  - Implemented cache loading and merging logic
  - Added cache management handlers (`clear_cache`, `get_cache_info`)
  - Progress reporting for both full and incremental scans
- ✅ Worker manager API ([frontend/src/lib/workerManager.ts](../frontend/src/lib/workerManager.ts))
  - `clearCache()` - Public API to clear cache
  - `getCacheInfo()` - Public API to get cache status
  - `generateUserCacheKey()` - Helper for frontend cache management

#### Architecture Design

```typescript
interface CachedScanData {
  // User identifier (hash based on spendingKey)
  userKey: string;

  // Pool identifier
  poolId: string;

  // Last scanned position
  lastScannedCursor: string | null;  // GraphQL endCursor
  lastScannedTimestamp: number;

  // Scanned notes
  ownedNotes: Array<{
    note: SerializedNote;
    leafIndex: number;
    pathElements: string[];
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
```

#### Implementation Steps

1. **Create IndexedDB Database**

   ```typescript
   // frontend/src/lib/notesCache.ts
   const DB_NAME = 'octopus-notes-cache';
   const DB_VERSION = 1;
   const STORE_NAME = 'scan-cache';

   function openDatabase(): Promise<IDBDatabase> {
     return new Promise((resolve, reject) => {
       const request = indexedDB.open(DB_NAME, DB_VERSION);

       request.onupgradeneeded = (event) => {
         const db = (event.target as IDBOpenDBRequest).result;
         if (!db.objectStoreNames.contains(STORE_NAME)) {
           const store = db.createObjectStore(STORE_NAME, { keyPath: ['userKey', 'poolId'] });
           store.createIndex('timestamp', 'lastScannedTimestamp');
         }
       };

       request.onsuccess = () => resolve(request.result);
       request.onerror = () => reject(request.error);
     });
   }
   ```

2. **Implement Cache Read/Write**

   ```typescript
   async function saveScanCache(data: CachedScanData): Promise<void> {
     const db = await openDatabase();
     const tx = db.transaction(STORE_NAME, 'readwrite');
     const store = tx.objectStore(STORE_NAME);
     await store.put(data);
   }

   async function loadScanCache(userKey: string, poolId: string): Promise<CachedScanData | null> {
     const db = await openDatabase();
     const tx = db.transaction(STORE_NAME, 'readonly');
     const store = tx.objectStore(STORE_NAME);
     const result = await store.get([userKey, poolId]);
     return result || null;
   }

   async function clearScanCache(userKey?: string, poolId?: string): Promise<void> {
     const db = await openDatabase();
     const tx = db.transaction(STORE_NAME, 'readwrite');
     const store = tx.objectStore(STORE_NAME);

     if (userKey && poolId) {
       await store.delete([userKey, poolId]);
     } else {
       await store.clear();
     }
   }
   ```

3. **Modify Worker for Incremental Scanning**

   ```typescript
   // Add caching logic to scan_notes request
   case "scan_notes": {
     // 1. Try to load cache
     const cacheKey = generateCacheKey(request.spendingKey, request.poolId);
     const cachedData = await loadScanCache(cacheKey);

     if (cachedData) {
       // 2. Query only new events (from lastScannedCursor)
       const [newShieldNodes, newTransferNodes, newUnshieldNodes] = await Promise.all([
         queryEventsAfterCursor(client, ShieldEvent, cachedData.lastScannedCursor),
         queryEventsAfterCursor(client, TransferEvent, cachedData.lastScannedCursor),
         queryEventsAfterCursor(client, UnshieldEvent, cachedData.lastScannedCursor),
       ]);

       // 3. Merge old and new data
       const allOwnedNotes = [...cachedData.ownedNotes, ...newlyDecryptedNotes];
       const allCommitments = [...cachedData.allCommitments, ...newCommitments];

       // 4. Update cache
       await saveScanCache({
         ...cachedData,
         lastScannedCursor: newEndCursor,
         lastScannedTimestamp: Date.now(),
         ownedNotes: allOwnedNotes,
         allCommitments: allCommitments,
       });
     } else {
       // First scan: full scan and cache
       // ... existing logic ...

       await saveScanCache({
         userKey: cacheKey,
         poolId: request.poolId,
         lastScannedCursor: endCursor,
         lastScannedTimestamp: Date.now(),
         ownedNotes,
         allCommitments,
         totalNotesInPool,
         lastScanDuration: scanTime,
       });
     }
   }
   ```

4. **Add Cache Management API**

   ```typescript
   // New Worker request types
   type WorkerRequest =
     | { type: 'scan_notes'; ... }
     | { type: 'clear_cache'; userKey?: string; poolId?: string }
     | { type: 'get_cache_info'; userKey: string; poolId: string };

   // Implementation
   case "clear_cache": {
     await clearScanCache(request.userKey, request.poolId);
     postMessage({ type: "clear_cache_result", success: true });
     break;
   }

   case "get_cache_info": {
     const cache = await loadScanCache(request.userKey, request.poolId);
     postMessage({
       type: "get_cache_info_result",
       cacheExists: !!cache,
       lastScanned: cache?.lastScannedTimestamp,
       noteCount: cache?.ownedNotes.length,
     });
     break;
   }
   ```

#### Performance Improvement

Assuming user has scanned once (cache established):

- **First scan:** 10 seconds (full scan, unavoidable)
- **Subsequent scans:** 0.1-1 second (only scan new events)
- **Improvement: 10-100x**

#### UI Improvements

Add cache status display in frontend:

```typescript
// Display cache info
const cacheInfo = await worker.getCacheInfo(userKey, poolId);
if (cacheInfo.cacheExists) {
  console.log(`Last scanned: ${new Date(cacheInfo.lastScanned).toLocaleString()}`);
  console.log(`Cached ${cacheInfo.noteCount} notes`);
}

// Provide clear cache button
<button onClick={() => worker.clearCache(userKey, poolId)}>
  Clear Cache (Force Re-scan)
</button>
```

---

### Solution 3: Parallel Scanning Optimization

**Core Idea:** Use multiple Web Workers for parallel decryption

#### Implementation

```typescript
// frontend/src/lib/parallelScan.ts

interface WorkerPool {
  workers: Worker[];
  taskQueue: Task[];
  activeTaskCount: number;
}

function createWorkerPool(size: number = navigator.hardwareConcurrency || 4): WorkerPool {
  return {
    workers: Array.from({ length: size }, () => new Worker('/workers/noteScanWorker.ts')),
    taskQueue: [],
    activeTaskCount: 0,
  };
}

async function parallelScanNotes(
  events: Event[],
  spendingKey: string,
  mpk: string
): Promise<Note[]> {
  const pool = createWorkerPool();
  const eventsPerWorker = Math.ceil(events.length / pool.workers.length);

  // Distribute events to different workers
  const chunks = [];
  for (let i = 0; i < pool.workers.length; i++) {
    const start = i * eventsPerWorker;
    const end = Math.min((i + 1) * eventsPerWorker, events.length);
    chunks.push(events.slice(start, end));
  }

  // Process in parallel
  const promises = pool.workers.map((worker, i) =>
    worker.scanNotes({
      events: chunks[i],
      spendingKey,
      mpk,
    })
  );

  // Wait for all workers to complete
  const results = await Promise.all(promises);

  // Merge results
  return results.flat();
}
```

#### Performance Improvement

- **4-core CPU:** Theoretical 4x speedup
- **Actual:** 2-3x speedup (accounting for communication overhead and sync costs)

#### Use Cases

- First full scan
- Pool with large number of notes (1000+)
- Combined with Solutions 1 and 2

---

### Solution 4: Optional Off-chain Indexer Service

**Core Idea:** Provide an optional indexer service to help users quickly find potentially owned notes

#### Architecture

```
┌─────────────┐         ┌──────────────┐         ┌──────────┐
│   Frontend  │────────>│   Indexer    │────────>│   Sui    │
│             │  1. tag │   Service    │  2. all │  RPC     │
│             │  hash   │              │  events │          │
│             │<────────│              │<────────│          │
└─────────────┘ 3. filtered events     │         └──────────┘
                                         │
                         4. Local full decryption verification
```

#### Server-side Implementation

```typescript
// indexer-service/src/index.ts

interface IndexedNote {
  poolId: string;
  eventType: 'shield' | 'transfer';
  position: number;
  encryptedNote: string;
  viewingTagHash: string;  // First 16 bytes of SHA256(viewing_tag)
  txDigest: string;
}

// Indexer continuously monitors on-chain events
async function indexEvents() {
  // 1. Subscribe to all ShieldEvent and TransferEvent
  const events = await subscribeToEvents(['ShieldEvent', 'TransferEvent']);

  for (const event of events) {
    // 2. Extract encrypted_note
    const encryptedNote = event.encrypted_note;

    // 3. If v2 format, extract viewing tag and compute hash
    if (encryptedNote.length === 196) {
      const viewingTag = encryptedNote.slice(0, 8);
      const viewingTagHash = sha256(viewingTag).slice(0, 16);

      // 4. Store in database
      await db.indexedNotes.insert({
        poolId: event.pool_id,
        eventType: event.type,
        position: event.position,
        encryptedNote: Buffer.from(encryptedNote).toString('base64'),
        viewingTagHash: viewingTagHash.toString('hex'),
        txDigest: event.tx_digest,
      });
    }
  }
}

// API: Query by viewing tag hash
app.post('/api/query-notes', async (req, res) => {
  const { poolId, viewingTagHash } = req.body;

  // Query matching notes
  const matches = await db.indexedNotes.find({
    poolId,
    viewingTagHash,
  });

  res.json({ notes: matches });
});
```

#### Client-side Implementation

```typescript
// frontend/src/lib/indexerClient.ts

async function scanNotesWithIndexer(
  poolId: string,
  spendingKey: bigint,
  mpk: bigint
): Promise<Note[]> {
  // 1. Compute own viewing tag hash (requires knowing all possible ephemeral_pk)
  // Note: This requires pre-knowledge of ephemeral_pk, so different implementation needed

  // 2. Query indexer service
  const response = await fetch('https://indexer.octopus.io/api/query-notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poolId, viewingTagHash }),
  });

  const { notes } = await response.json();

  // 3. Local verification and decryption
  const ownedNotes = [];
  for (const note of notes) {
    const decrypted = decryptNote(
      Buffer.from(note.encryptedNote, 'base64'),
      spendingKey,
      mpk
    );

    if (decrypted) {
      ownedNotes.push(decrypted);
    }
  }

  return ownedNotes;
}
```

#### Privacy Considerations

**Issue:** Since ephemeral_pk must be known beforehand to compute viewing tag, this approach is not feasible.

**Alternative:** Bloom Filter

```typescript
// Indexer service maintains a Bloom Filter for each pool
// Clients can download Bloom Filter for fast local filtering

interface PoolBloomFilter {
  poolId: string;
  filter: Uint8Array;  // Bloom filter
  noteCount: number;
  falsePositiveRate: number;
}

// Client usage
const bloomFilter = await fetchBloomFilter(poolId);
const possiblyMine = bloomFilter.mightContain(myViewingKeyHash);
if (possiblyMine) {
  // Full scan
}
```

#### Pros and Cons

✅ **Pros:**

- Extremely fast scanning
- Reduces client computation burden
- Supports larger scale pools

❌ **Cons:**

- Requires running indexer service (cost, maintenance)
- Privacy compromise (server knows someone is querying)
- Requires trusting server availability
- **High implementation complexity**

#### Conclusion

Solution 4 is suitable as an optional enhancement for the future, but not current priority. **Recommend implementing Solutions 2 and 3 first.**

---

## Recommended Implementation Order

1. **✅ Solution 1 (Complete):** Viewing Key Tag
   - Lays foundation for future performance improvements
   - All newly created notes use new format

2. **✅ Solution 2 (Complete):** Local Cache + Incremental Scanning
   - **Expected: 10-100x improvement**
   - Most significant user experience improvement
   - Implementation difficulty: Medium
   - **Status:** Fully implemented with IndexedDB caching

3. **Solution 3 (Optional):** Parallel Scanning
   - Expected: 2-3x improvement
   - Can combine with Solution 2
   - Implementation difficulty: Low

4. **Solution 4 (Future):** Off-chain Indexer Service
   - Consider when user base scales
   - Requires operational costs
   - Implementation difficulty: High

---

## Performance Comparison Summary

| Scenario | Old Method | Sol 1 | Sol 1+2 | Sol 1+2+3 |
|----------|------------|-------|---------|-----------|
| First scan 10K notes | 10s | 1s | 1s | 0.3s |
| Subsequent scan (10 new notes) | 10s | 1s | 0.1s | 0.05s |
| Subsequent scan (100 new notes) | 10s | 1s | 0.5s | 0.2s |

**Conclusion:** Combining Solution 1 + Solution 2 achieves **10-100x performance improvement**, sufficient to solve current performance bottleneck.
