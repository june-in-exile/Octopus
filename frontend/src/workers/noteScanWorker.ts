/**
 * Note Scanning Web Worker
 * Handles CPU-intensive cryptographic operations off the main thread
 */

import { buildPoseidon } from "circomlibjs";
import type { Poseidon } from "circomlibjs";
import {
  decryptNote as sdkDecryptNote,
  computeNullifier as sdkComputeNullifier,
  initPoseidon as sdkInitPoseidon,
  quickCheckNote as sdkQuickCheckNote,
  bytesToBigIntLE_BN254,
} from "@june_zk/octopus-sdk";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { graphql } from "@mysten/sui/graphql/schema";
import type {
  WorkerRequest,
  WorkerResponse,
  SerializedNote,
} from "./types";
import {
  saveScanCache,
  loadScanCache,
  clearScanCache,
  generateCacheKey,
  type CachedScanData,
} from "../lib/notesCache";

// Worker State
let isInitialized = false;
let poseidon: Poseidon | null = null;
const merkleTreeCache = new Map<string, ClientMerkleTree>();
const MERKLE_TREE_DEPTH = 16;

async function initialize(): Promise<void> {
  if (isInitialized) return;

  try {
    await sdkInitPoseidon();
    poseidon = await buildPoseidon();
    isInitialized = true;
    postMessage({ type: "init_complete", success: true } as WorkerResponse);
  } catch (error) {
    postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Init failed",
    } as WorkerResponse);
  }
}

function hash(inputs: bigint[]): bigint {
  if (!poseidon) throw new Error("Poseidon not initialized");
  const h = poseidon(inputs);
  return BigInt(poseidon.F.toString(h));
}

function isValidNoteField(amount: unknown): boolean {
  if (amount === undefined) return false;
  if (typeof amount === 'number' && isNaN(amount)) return false;
  return true;
}

function decryptNote(
  encryptedData: number[],
  mySpendingKey: bigint,
  myMpk: bigint
): SerializedNote | null {
  try {
    const note = sdkDecryptNote(encryptedData, mySpendingKey, myMpk);
    if (!note) return null;

    // Validate all required fields
    const fields = ['nsk', 'token', 'amount', 'random', 'commitment'] as const;
    if (!fields.every(field => isValidNoteField(note[field]))) {
      return null;
    }

    // Serialize to strings
    const serialized = {
      nsk: note.nsk.toString(),
      token: note.token.toString(),
      amount: note.amount.toString(),
      random: note.random.toString(),
      commitment: note.commitment.toString(),
    };

    // Validate serialization
    const invalidStrings = ['undefined', 'NaN'];
    if (Object.values(serialized).some(val => invalidStrings.includes(val))) {
      return null;
    }

    return serialized;
  } catch {
    return null;
  }
}

function computeNullifier(nullifyingKey: bigint, leafIndex: number): string {
  return sdkComputeNullifier(nullifyingKey, leafIndex).toString();
}

function quickCheckNote(encryptedData: number[], mySpendingKey: bigint): boolean {
  try {
    return sdkQuickCheckNote(encryptedData, mySpendingKey);
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// Merkle Tree Implementation
class ClientMerkleTree {
  private leaves: Map<number, bigint> = new Map();
  private zeros: bigint[];
  private depth = MERKLE_TREE_DEPTH;

  constructor() {
    this.zeros = this.computeZeroHashes();
  }

  /**
   * Compute zero hashes for empty nodes
   * Must match Move contract logic (merkle_tree.move:compute_zeros)
   */
  private computeZeroHashes(): bigint[] {
    const zeros: bigint[] = [];
    zeros[0] = 0n;

    for (let i = 1; i <= this.depth; i++) {
      zeros[i] = hash([zeros[i - 1], zeros[i - 1]]);
    }

    return zeros;
  }

  insert(leafIndex: number, commitment: bigint): void {
    this.leaves.set(leafIndex, commitment);
  }

  getMerkleProof(leafIndex: number): bigint[] {
    const commitment = this.leaves.get(leafIndex);
    if (!commitment) {
      throw new Error(`No leaf at index ${leafIndex}`);
    }

    const pathElements: bigint[] = [];
    let currentIndex = leafIndex;

    for (let level = 0; level < this.depth; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

      let sibling: bigint;
      if (this.leaves.has(siblingIndex)) {
        sibling =
          level === 0
            ? this.leaves.get(siblingIndex)!
            : this.computeSubtreeHash(siblingIndex, level);
      } else {
        sibling = this.zeros[level];
      }

      pathElements.push(sibling);
      currentIndex = Math.floor(currentIndex / 2);
    }

    return pathElements;
  }

  private computeSubtreeHash(nodeIndex: number, level: number): bigint {
    if (level === 0) {
      return this.leaves.get(nodeIndex) || this.zeros[0];
    }

    const leftIndex = nodeIndex * 2;
    const rightIndex = nodeIndex * 2 + 1;

    const leftHash = this.computeSubtreeHash(leftIndex, level - 1);
    const rightHash = this.computeSubtreeHash(rightIndex, level - 1);

    return hash([leftHash, rightHash]);
  }

  getRoot(): bigint {
    if (this.leaves.size === 0) {
      return this.zeros[this.depth];
    }
    return this.computeSubtreeHash(0, this.depth);
  }
}

// ---------------------------------------------------------------------------
// Shared note-scanning types
// ---------------------------------------------------------------------------

type OwnedNote = {
  note: SerializedNote;
  leafIndex: number;
  nullifier: string;
  txDigest: string;
  /** Actual amount received (from SwapEvent.amount_out). Only set for swap output notes.
   *  The note.amount holds min_amount_out (what the ZKP commits to, used for proof generation).
   *  displayAmount holds the real DeepBook output for UI display. */
  displayAmount?: string;
};

type CollectedCommitment = {
  commitment: bigint;
  leafIndex: number;
};

type PoolEvents = {
  shieldNodes: any[];
  transferNodes: any[];
  unshieldNodes: any[];
  swapNodes: any[];
  /** Cursor to resume from on the next incremental scan */
  endCursor: string | null;
};

type FilteredPoolEvents = {
  shieldEvents: any[];
  transferEvents: any[];
  unshieldEvents: any[];
  swapOutputEvents: any[];  // events whose pool_out_id matches
  swapInputEvents: any[];   // events whose pool_in_id matches (for nullifier counting)
  transferOutputNotesCount: number;
};

type DecryptContext = {
  spendingKey: bigint;
  masterPublicKey: bigint;
  nullifyingKey: bigint;
  poolId: string;
};

// ---------------------------------------------------------------------------
// Module-level helpers (used by both scan_notes and other cases)
// ---------------------------------------------------------------------------

function decodeEncryptedNote(encryptedNote: string | number[]): number[] | null {
  if (typeof encryptedNote === 'string') return decodeBase64(encryptedNote);
  if (Array.isArray(encryptedNote)) return encryptedNote;
  return null;
}

function parseCommitment(commitment: string | number[]): bigint {
  const bytes = typeof commitment === 'string'
    ? Array.from(Buffer.from(commitment, 'base64'))
    : commitment;
  return bytesToBigIntLE_BN254(bytes);
}

function isNonZeroNullifier(n: any): boolean {
  if (Array.isArray(n)) return n.some((b: number) => b !== 0);
  return n !== null && n !== undefined;
}

// ---------------------------------------------------------------------------
// Event fetching & filtering
// ---------------------------------------------------------------------------

async function fetchAllPoolEvents(
  client: SuiGraphQLClient,
  packageId: string,
  startCursor: string | null,
): Promise<PoolEvents> {
  const [shieldResult, transferResult, unshieldResult, swapResult] = await Promise.all([
    queryAllEvents(client, `${packageId}::pool::ShieldEvent`, 'ShieldEvents', startCursor),
    queryAllEvents(client, `${packageId}::pool::TransferEvent`, 'TransferEvents', startCursor),
    queryAllEvents(client, `${packageId}::pool::UnshieldEvent`, 'UnshieldEvents', startCursor),
    queryAllEvents(client, `${packageId}::pool::SwapEvent`, 'SwapEvents', startCursor),
  ]);

  return {
    shieldNodes: shieldResult.nodes,
    transferNodes: transferResult.nodes,
    unshieldNodes: unshieldResult.nodes,
    swapNodes: swapResult.nodes,
    endCursor: transferResult.endCursor,
  };
}

function filterEventsByPool(events: PoolEvents, poolId: string): FilteredPoolEvents {
  const byPoolId = (nodes: any[]) =>
    nodes.filter(n => (n.contents?.json as any)?.pool_id === poolId);

  const shieldEvents = byPoolId(events.shieldNodes);
  const transferEvents = byPoolId(events.transferNodes);
  const unshieldEvents = byPoolId(events.unshieldNodes);
  const swapOutputEvents = events.swapNodes.filter(
    n => (n.contents?.json as any)?.pool_out_id === poolId,
  );
  const swapInputEvents = events.swapNodes.filter(
    n => (n.contents?.json as any)?.pool_in_id === poolId,
  );

  const transferOutputNotesCount = transferEvents.reduce((sum, n) => {
    const outputNotes = (n.contents?.json as any)?.output_notes ?? [];
    return sum + outputNotes.length;
  }, 0);

  return { shieldEvents, transferEvents, unshieldEvents, swapOutputEvents, swapInputEvents, transferOutputNotesCount };
}

// ---------------------------------------------------------------------------
// Nullifier counting
// ---------------------------------------------------------------------------

/** Count nullifiers by walking the on-chain NullifierRegistry dynamic fields. */
async function queryOnChainNullifierCount(
  client: SuiGraphQLClient,
  poolId: string,
): Promise<number> {
  const poolQuery = await withTimeout(
    client.query({
      query: graphql(`
        query NullifierCount($poolId: SuiAddress!) {
          object(address: $poolId) {
            asMoveObject {
              contents { json }
            }
          }
        }
      `),
      variables: { poolId },
    }),
    30000,
    'Nullifier count query',
  );

  const poolData = poolQuery.data?.object?.asMoveObject?.contents?.json as any;
  const registryId = poolData?.nullifiers?.id;
  if (!registryId) throw new Error('Nullifiers registry ID not found in pool data');

  let count = 0;
  let hasNextPage = true;
  let cursor: string | null = null;
  const MAX_NULLIFIERS = 1000;

  while (hasNextPage && count < MAX_NULLIFIERS) {
    const dfQuery: any = await withTimeout(
      client.query({
        query: graphql(`
          query NullifierRegistryDynamicFields($registryId: SuiAddress!, $first: Int, $after: String) {
            object(address: $registryId) {
              dynamicFields(first: $first, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes { name { type { repr } json } }
              }
            }
          }
        `),
        variables: { registryId, first: 50, after: cursor },
      }),
      30000,
      'Nullifier registry dynamic fields query',
    );

    const nodes = dfQuery.data?.object?.dynamicFields?.nodes ?? [];
    // Only vector<u8> keys are nullifiers
    count += nodes.filter((n: any) =>
      (n.name?.type?.repr ?? '').includes('vector<u8>')
    ).length;

    hasNextPage = dfQuery.data?.object?.dynamicFields?.pageInfo?.hasNextPage ?? false;
    cursor = dfQuery.data?.object?.dynamicFields?.pageInfo?.endCursor ?? null;
  }

  return count;
}

/** Event-based fallback nullifier count (used when on-chain query fails). */
function computeEventBasedNullifierCount(filtered: FilteredPoolEvents): number {
  const fromUnshield = filtered.unshieldEvents.length;

  const fromTransfer = filtered.transferEvents.reduce((sum, event) => {
    const nullifiers = (event.contents?.json as any)?.input_nullifiers ?? [];
    return sum + nullifiers.filter(isNonZeroNullifier).length;
  }, 0);

  const fromSwap = filtered.swapInputEvents.reduce((sum, event) => {
    const nullifiers = (event.contents?.json as any)?.input_nullifiers ?? [];
    return sum + nullifiers.filter(isNonZeroNullifier).length;
  }, 0);

  return fromUnshield + fromTransfer + fromSwap;
}

/** Returns the nullifier count and whether the fallback path was used. */
async function resolveNullifierCount(
  client: SuiGraphQLClient,
  poolId: string,
  filtered: FilteredPoolEvents,
): Promise<{ count: number; usedFallback: boolean }> {
  const eventCount = computeEventBasedNullifierCount(filtered);

  try {
    const onChainCount = await queryOnChainNullifierCount(client, poolId);
    // Guard against stale/empty on-chain registry
    if (onChainCount === 0 && eventCount > 0) {
      return { count: eventCount, usedFallback: true };
    }
    return { count: onChainCount, usedFallback: false };
  } catch {
    return { count: eventCount, usedFallback: true };
  }
}

// ---------------------------------------------------------------------------
// Note decryption helpers
// ---------------------------------------------------------------------------

function tryDecryptOwnedNote(
  encryptedNoteBytes: number[],
  rawCommitment: string | number[],
  leafIndex: number,
  txDigest: string,
  ctx: DecryptContext,
): OwnedNote | null {
  if (!quickCheckNote(encryptedNoteBytes, ctx.spendingKey)) return null;

  const note = decryptNote(encryptedNoteBytes, ctx.spendingKey, ctx.masterPublicKey);
  if (!note) return null;

  const onChainCommitment = parseCommitment(rawCommitment);
  if (BigInt(note.commitment) !== onChainCommitment) return null;

  return {
    note,
    leafIndex,
    nullifier: computeNullifier(ctx.nullifyingKey, leafIndex),
    txDigest,
  };
}

// ---------------------------------------------------------------------------
// Per-event-type processors
// ---------------------------------------------------------------------------

function processShieldEvents(
  nodes: any[],
  ctx: DecryptContext,
): { ownedNotes: OwnedNote[]; commitments: CollectedCommitment[] } {
  const ownedNotes: OwnedNote[] = [];
  const commitments: CollectedCommitment[] = [];

  for (const node of nodes) {
    const data = node.contents?.json as any;
    if (!data || (data.pool_id && data.pool_id !== ctx.poolId)) continue;

    const leafIndex = Number(data.position);
    try {
      commitments.push({ commitment: parseCommitment(data.commitment), leafIndex });
    } catch (err) {
      throw new Error(`Failed to parse shield commitment at position ${leafIndex}: ${err instanceof Error ? err.message : err}`);
    }

    const encryptedBytes = decodeEncryptedNote(data.encrypted_note);
    if (!encryptedBytes) continue;

    const owned = tryDecryptOwnedNote(
      encryptedBytes, data.commitment, leafIndex,
      (node.transaction as any)?.digest ?? '', ctx,
    );
    if (owned) ownedNotes.push(owned);
  }

  return { ownedNotes, commitments };
}

function processTransferEvents(
  nodes: any[],
  ctx: DecryptContext,
): { ownedNotes: OwnedNote[]; commitments: CollectedCommitment[] } {
  const ownedNotes: OwnedNote[] = [];
  const commitments: CollectedCommitment[] = [];

  for (const node of nodes) {
    const data = node.contents?.json as any;
    if (!data || (data.pool_id && data.pool_id !== ctx.poolId)) continue;

    const { output_notes, output_positions, output_commitments } = data;
    const txDigest = (node.transaction as any)?.digest ?? '';

    for (let i = 0; i < output_notes.length; i++) {
      const leafIndex = Number(output_positions[i]);
      try {
        commitments.push({ commitment: parseCommitment(output_commitments[i]), leafIndex });
      } catch (err) {
        throw new Error(`Failed to parse transfer commitment at index ${i}: ${err instanceof Error ? err.message : err}`);
      }

      const encryptedBytes = decodeEncryptedNote(output_notes[i]);
      if (!encryptedBytes) continue;

      const owned = tryDecryptOwnedNote(encryptedBytes, output_commitments[i], leafIndex, txDigest, ctx);
      if (owned) ownedNotes.push(owned);
    }
  }

  return { ownedNotes, commitments };
}

function processSwapEvents(
  nodes: any[],
  ctx: DecryptContext,
): { ownedNotes: OwnedNote[]; commitments: CollectedCommitment[] } {
  const ownedNotes: OwnedNote[] = [];
  const commitments: CollectedCommitment[] = [];

  for (const node of nodes) {
    const data = node.contents?.json as any;
    if (!data || data.pool_out_id !== ctx.poolId) continue;

    const leafIndex = Number(data.swap_position);
    try {
      commitments.push({ commitment: parseCommitment(data.swap_commitment), leafIndex });
    } catch (err) {
      throw new Error(`Failed to parse swap commitment at position ${leafIndex}: ${err instanceof Error ? err.message : err}`);
    }

    const encryptedBytes = decodeEncryptedNote(data.encrypted_output_note);
    if (!encryptedBytes) continue;

    const owned = tryDecryptOwnedNote(
      encryptedBytes, data.swap_commitment, leafIndex,
      (node.transaction as any)?.digest ?? '', ctx,
    );
    if (!owned) continue;

    // note.amount = min_amount_out (committed to ZKP, used for proof generation)
    // displayAmount = actual DeepBook output (for UI display only)
    const actualAmountOut = BigInt(data.amount_out ?? owned.note.amount);
    ownedNotes.push({ ...owned, displayAmount: actualAmountOut.toString() });
  }

  return { ownedNotes, commitments };
}

// ---------------------------------------------------------------------------
// Cache merge
// ---------------------------------------------------------------------------

function mergeWithCache(
  newNotes: OwnedNote[],
  newCommitments: CollectedCommitment[],
  cachedData: CachedScanData | null,
): { notes: OwnedNote[]; commitments: CollectedCommitment[] } {
  if (!cachedData) {
    return { notes: newNotes, commitments: newCommitments };
  }

  const cachedNotes: OwnedNote[] = cachedData.ownedNotes.map(n => ({
    note: n.note,
    leafIndex: n.leafIndex,
    nullifier: n.nullifier,
    txDigest: n.txDigest,
    displayAmount: (n as any).displayAmount,
  }));

  const cachedCommitments: CollectedCommitment[] = cachedData.allCommitments.map(c => ({
    commitment: BigInt(c.commitment),
    leafIndex: c.leafIndex,
  }));

  return {
    notes: [...cachedNotes, ...newNotes],
    commitments: [...newCommitments, ...cachedCommitments],
  };
}

// ---------------------------------------------------------------------------
// Core scan orchestration
// ---------------------------------------------------------------------------

type ScanResult = {
  notes: OwnedNote[];
  commitments: CollectedCommitment[];
  totalNotesInPool: number;
  endCursor: string | null;
};

async function scanPoolNotes(
  client: SuiGraphQLClient,
  request: Extract<WorkerRequest, { type: 'scan_notes' }>,
  cachedData: CachedScanData | null,
  onProgress: (current: number, total: number, message: string, totalNotesInPool?: number) => void,
): Promise<ScanResult> {
  const startCursor = cachedData?.lastScannedCursor ?? null;

  const events = await fetchAllPoolEvents(client, request.packageId, startCursor);
  const filtered = filterEventsByPool(events, request.poolId);

  const { count: nullifierCount, usedFallback } = await resolveNullifierCount(
    client, request.poolId, filtered,
  );

  const totalCommitments =
    filtered.shieldEvents.length +
    filtered.transferOutputNotesCount +
    filtered.swapOutputEvents.length;

  const totalNotesInPool = totalCommitments - nullifierCount;

  if (nullifierCount > totalCommitments) {
    onProgress(30, 100, `Warning: Spent nullifiers (${nullifierCount}) exceeds total commitments (${totalCommitments})`);
  }
  if (totalNotesInPool < 0) {
    onProgress(30, 100,
      `Error: Invalid pool state - negative note count! shields=${filtered.shieldEvents.length}, transferOutputs=${filtered.transferOutputNotesCount}, nullifiers=${nullifierCount}`,
    );
  }

  const totalEvents =
    events.shieldNodes.length + events.transferNodes.length + events.swapNodes.length;
  onProgress(30, 100,
    `Found ${totalEvents} events, decrypting notes... (Pool: ${filtered.shieldEvents.length} shields + ${filtered.transferOutputNotesCount} transfer outputs + ${filtered.swapOutputEvents.length} swap outputs - ${nullifierCount} spent${usedFallback ? ' [fallback]' : ''} = ${totalNotesInPool} notes)`,
    totalNotesInPool,
  );

  const ctx: DecryptContext = {
    spendingKey: BigInt(request.spendingKey),
    masterPublicKey: BigInt(request.masterPublicKey),
    nullifyingKey: BigInt(request.nullifyingKey),
    poolId: request.poolId,
  };

  const shieldResult = processShieldEvents(events.shieldNodes, ctx);
  const transferResult = processTransferEvents(events.transferNodes, ctx);
  const swapResult = processSwapEvents(events.swapNodes, ctx);

  const newNotes = [...shieldResult.ownedNotes, ...transferResult.ownedNotes, ...swapResult.ownedNotes];
  const newCommitments = [...shieldResult.commitments, ...transferResult.commitments, ...swapResult.commitments];

  const merged = mergeWithCache(newNotes, newCommitments, cachedData);

  const sortedCommitments = [...merged.commitments].sort((a, b) => a.leafIndex - b.leafIndex);

  return {
    notes: merged.notes,
    commitments: sortedCommitments,
    totalNotesInPool,
    endCursor: events.endCursor,
  };
}

/**
 * Query all pages of a specific event type
 */
async function queryAllEvents(
  client: SuiGraphQLClient,
  eventType: string,
  eventName: string,
  startCursor?: string | null
): Promise<{ nodes: any[]; endCursor: string | null }> {
  let allNodes: any[] = [];
  let hasNextPage = true;
  let cursor: string | null = startCursor || null;
  let pageCount = 0;
  const MAX_PAGES = 10;
  let finalEndCursor: string | null = null;

  while (hasNextPage && pageCount < MAX_PAGES) {
    pageCount++;
    const query: any = await withTimeout(
      client.query({
        query: graphql(`
          query Events($eventType: String!, $first: Int, $after: String) {
            events(first: $first, after: $after, filter: { type: $eventType }) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                transactionModule {
                  package { address }
                }
                contents {
                  json
                }
                transaction {
                  digest
                }
              }
            }
          }
        `),
        variables: {
          eventType,
          first: 50,
          after: cursor,
        },
      }),
      30000,
      `${eventName} GraphQL query`
    );

    const nodes = query.data?.events?.nodes || [];
    allNodes.push(...nodes);

    hasNextPage = query.data?.events?.pageInfo?.hasNextPage || false;
    finalEndCursor = query.data?.events?.pageInfo?.endCursor || null;
    cursor = finalEndCursor;
  }

  return { nodes: allNodes, endCursor: finalEndCursor };
}

/**
 * Count nullifiers spent in a pool
 */
async function countNullifiers(
  client: SuiGraphQLClient,
  poolId: string,
  unshieldEvents: any[],
  transferEvents: any[]
): Promise<number> {
  try {
    const nullifierQuery = await withTimeout(
      client.query({
        query: graphql(`
          query NullifierCount($poolId: SuiAddress!) {
            object(address: $poolId) {
              asMoveObject {
                contents {
                  json
                }
              }
            }
          }
        `),
        variables: { poolId },
      }),
      30000,
      'Nullifier count query'
    );

    const poolData = nullifierQuery.data?.object?.asMoveObject?.contents?.json as any;
    const count = poolData?.nullifiers?.count;

    if (count == null) throw new Error('Nullifier count not found in pool data');

    return Number(count);
  } catch {
    // Fallback: count from events
    let count = unshieldEvents.length;
    for (const e of transferEvents) {
      const nullifiers = (e.contents?.json as any)?.input_nullifiers || [];
      count += nullifiers.filter((n: any) =>
        Array.isArray(n) ? n.some((b: number) => b !== 0) : n != null
      ).length;
    }
    return count;
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case "init": {
        await initialize();
        break;
      }

      case "scan_notes": {
        if (!isInitialized) {
          throw new Error("Worker not initialized");
        }

        const scanStartTime = Date.now();
        const network = request.graphqlUrl.includes("mainnet") ? "mainnet" : "testnet";
        const client = new SuiGraphQLClient({ url: request.graphqlUrl, network });
        const cacheKey = await generateCacheKey(request.spendingKey);
        const cachedData = await loadScanCache(cacheKey, request.poolId);

        postMessage({
          type: "progress",
          id: request.id,
          current: 0,
          total: 100,
          message: cachedData
            ? `Found cache (${cachedData.ownedNotes.length} notes). Scanning for new events...`
            : "Starting full scan of blockchain events...",
        } as WorkerResponse);

        const scanResult = await scanPoolNotes(
          client,
          request,
          cachedData,
          (current, total, message, totalNotesInPool) => {
            postMessage({ type: "progress", id: request.id, current, total, message, totalNotesInPool } as WorkerResponse);
          },
        );

        postMessage({
          type: "progress",
          id: request.id,
          current: 100,
          total: 100,
          message: `Scan complete! Found ${scanResult.notes.length} notes.`,
        } as WorkerResponse);

        await saveScanCache({
          userKey: cacheKey,
          poolId: request.poolId,
          lastScannedCursor: scanResult.endCursor,
          lastScannedTimestamp: Date.now(),
          ownedNotes: scanResult.notes,
          allCommitments: scanResult.commitments.map(c => ({
            commitment: c.commitment.toString(),
            leafIndex: c.leafIndex,
          })),
          totalNotesInPool: scanResult.totalNotesInPool,
          lastScanDuration: Date.now() - scanStartTime,
        });

        postMessage({
          type: "scan_notes_result",
          id: request.id,
          notes: scanResult.notes,
          totalNotesInPool: scanResult.totalNotesInPool,
        } as WorkerResponse);
        break;
      }

      case "batch_decrypt": {
        if (!isInitialized) {
          throw new Error("Worker not initialized");
        }

        const results = request.notes.map(({ noteId, encryptedNote }) => ({
          noteId,
          note: decryptNote(
            encryptedNote,
            BigInt(request.spendingKey),
            BigInt(request.masterPublicKey)
          ),
        }));

        const response: WorkerResponse = {
          type: "batch_decrypt_result",
          id: request.id,
          results,
        };
        postMessage(response);
        break;
      }

      case "compute_nullifier": {
        if (!isInitialized) {
          throw new Error("Worker not initialized");
        }

        const nullifier = computeNullifier(
          BigInt(request.nullifyingKey),
          request.leafIndex
        );

        const response: WorkerResponse = {
          type: "compute_nullifier_result",
          id: request.id,
          nullifier,
        };
        postMessage(response);
        break;
      }

      case "build_merkle_tree": {
        if (!isInitialized) {
          throw new Error("Worker not initialized");
        }

        const tree = new ClientMerkleTree();

        for (const { commitment, leafIndex } of request.commitments) {
          tree.insert(leafIndex, BigInt(commitment));
        }

        const treeId = request.id;
        merkleTreeCache.set(treeId, tree);

        const root = tree.getRoot().toString();

        const response: WorkerResponse = {
          type: "build_merkle_tree_result",
          id: request.id,
          treeId,
          root,
        };
        postMessage(response);
        break;
      }

      case "count_pool_notes": {
        const network = request.graphqlUrl.includes("mainnet") ? "mainnet" : "testnet";
        const client = new SuiGraphQLClient({ url: request.graphqlUrl, network });

        const [shieldResult, transferResult, unshieldResult, swapResult] = await Promise.all([
          queryAllEvents(client, `${request.packageId}::pool::ShieldEvent`, 'ShieldEvents'),
          queryAllEvents(client, `${request.packageId}::pool::TransferEvent`, 'TransferEvents'),
          queryAllEvents(client, `${request.packageId}::pool::UnshieldEvent`, 'UnshieldEvents'),
          queryAllEvents(client, `${request.packageId}::pool::SwapEvent`, 'SwapEvents'),
        ]);

        const shieldNodes = shieldResult.nodes;
        const transferNodes = transferResult.nodes;
        const unshieldNodes = unshieldResult.nodes;
        const swapNodes = swapResult.nodes;

        const filterByPool = (nodes: any[]) =>
          nodes.filter(node => (node.contents?.json as any)?.pool_id === request.poolId);

        const shieldEventsInPool = filterByPool(shieldNodes);
        const transferEventsInPool = filterByPool(transferNodes);
        const unshieldEventsInPool = filterByPool(unshieldNodes);
        // SwapEvent uses pool_out_id for the output note's pool
        const swapEventsInPool = swapNodes.filter(
          node => (node.contents?.json as any)?.pool_out_id === request.poolId
        );

        const transferOutputNotesCount = transferEventsInPool.reduce((sum, node) => {
          const output_notes = (node.contents?.json as any)?.output_notes || [];
          return sum + output_notes.length;
        }, 0);

        const nullifierCount = await countNullifiers(
          client,
          request.poolId,
          unshieldEventsInPool,
          transferEventsInPool
        );

        const totalNotesInPool = shieldEventsInPool.length + transferOutputNotesCount + swapEventsInPool.length - nullifierCount;

        const response: WorkerResponse = {
          type: "count_pool_notes_result",
          id: request.id,
          totalNotesInPool: Math.max(0, totalNotesInPool),
        };
        postMessage(response);
        break;
      }

      case "get_merkle_proof": {
        if (!isInitialized) {
          throw new Error("Worker not initialized");
        }

        const tree = merkleTreeCache.get(request.treeId);
        if (!tree) {
          throw new Error(`Tree ${request.treeId} not found`);
        }

        const pathElements = tree.getMerkleProof(request.leafIndex);

        const response: WorkerResponse = {
          type: "get_merkle_proof_result",
          id: request.id,
          pathElements: pathElements.map((p) => p.toString()),
        };
        postMessage(response);
        break;
      }

      case "get_commitments": {
        try {
          const cache = await loadScanCache(request.userKey, request.poolId);

          if (!cache) {
            throw new Error("No scan cache found. Please refresh your notes first.");
          }

          const commitments = cache.allCommitments ?? [];

          if (commitments.length === 0) {
            throw new Error("No commitments in cache. Please refresh your notes.");
          }

          const response: WorkerResponse = {
            type: "get_commitments_result",
            id: request.id,
            commitments,
          };
          postMessage(response);
        } catch (err) {
          postMessage({
            type: "error",
            id: request.id,
            error: err instanceof Error ? err.message : "Failed to get commitments",
          } as WorkerResponse);
        }
        break;
      }

      case "clear_cache": {
        await clearScanCache(request.userKey, request.poolId);
        const response: WorkerResponse = {
          type: "clear_cache_result",
          id: request.id,
          success: true,
        };
        postMessage(response);
        break;
      }

      case "get_cache_info": {
        const cache = await loadScanCache(request.userKey, request.poolId);
        const response: WorkerResponse = {
          type: "get_cache_info_result",
          id: request.id,
          cacheExists: !!cache,
          lastScanned: cache?.lastScannedTimestamp,
          noteCount: cache?.ownedNotes.length,
          totalNotesInPool: cache?.totalNotesInPool,
        };
        postMessage(response);
        break;
      }
    }
  } catch (error) {
    const response: WorkerResponse = {
      type: "error",
      id: "id" in request ? request.id : undefined,
      error: error instanceof Error ? error.message : "Unknown error",
    };
    postMessage(response);
  }
};

function decodeBase64(input: string): number[] {
  try {
    // Use built-in atob (browser) or Buffer (Node.js)
    const binaryString = typeof atob !== 'undefined'
      ? atob(input)
      : Buffer.from(input, 'base64').toString('binary');

    return Array.from(binaryString, char => char.charCodeAt(0));
  } catch (err) {
    throw new Error(`Failed to decode Base64 string: ${input}`);
  }
}