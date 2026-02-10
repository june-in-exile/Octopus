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
import { graphql } from "@mysten/sui/graphql/schemas/latest";
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

function isValidNoteField(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === 'number' && isNaN(value)) return false;
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
    const fields = ['nsk', 'token', 'value', 'random', 'commitment'] as const;
    if (!fields.every(field => isValidNoteField(note[field]))) {
      return null;
    }

    // Serialize to strings
    const serialized = {
      nsk: note.nsk.toString(),
      token: note.token.toString(),
      value: note.value.toString(),
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
  console.log('[Worker] Message received:', request.type, 'id' in request ? request.id : 'N/A');

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

        // Create GraphQL client
        const client = new SuiGraphQLClient({ url: request.graphqlUrl });

        // Generate cache key from spending key
        const cacheKey = await generateCacheKey(request.spendingKey);

        // Try to load existing cache
        const cachedData = await loadScanCache(cacheKey, request.poolId);

        const ownedNotes: Array<{
          note: SerializedNote;
          leafIndex: number;
          nullifier: string;
          txDigest: string;
        }> = [];

        // Collect all commitments for Merkle tree construction
        const allCommitments: Array<{
          commitment: bigint;
          leafIndex: number;
        }> = [];

        if (cachedData) {
          postMessage({
            type: "progress",
            id: request.id,
            current: 0,
            total: 100,
            message: `Found cache (${cachedData.ownedNotes.length} notes). Scanning for new events...`,
          } as WorkerResponse);
          console.log("Cache found!");
        } else {
          postMessage({
            type: "progress",
            id: request.id,
            current: 0,
            total: 100,
            message: "Starting full scan of blockchain events...",
          } as WorkerResponse);
          console.log("Full scanning...");
        }

        // Parallel query of Shield, Transfer, and Unshield events
        // If cache exists, start from last scanned cursor
        const startCursor = cachedData?.lastScannedCursor || null;

        const [shieldResult, transferResult, unshieldResult] = await Promise.all([
          queryAllEvents(client, `${request.packageId}::pool::ShieldEvent`, 'ShieldEvents', startCursor),
          queryAllEvents(client, `${request.packageId}::pool::TransferEvent`, 'TransferEvents', startCursor),
          queryAllEvents(client, `${request.packageId}::pool::UnshieldEvent`, 'UnshieldEvents', startCursor),
        ]);

        const allShieldNodes = shieldResult.nodes;
        const allTransferNodes = transferResult.nodes;
        const allUnshieldNodes = unshieldResult.nodes;
        const finalEndCursor = transferResult.endCursor; // Use any result's cursor for cache

        console.log(`[${cachedData ? 'INCREMENTAL' : 'FULL'} SCAN] NEW shield events:`, allShieldNodes.length);
        console.log(`[${cachedData ? 'INCREMENTAL' : 'FULL'} SCAN] NEW transfer events:`, allTransferNodes.length);
        console.log(`[${cachedData ? 'INCREMENTAL' : 'FULL'} SCAN] NEW unshield events:`, allUnshieldNodes.length);

        // Filter events by pool_id
        const filterByPool = (nodes: any[]) =>
          nodes.filter(node => (node.contents?.json as any)?.pool_id === request.poolId);

        const shieldEventsInPool = filterByPool(allShieldNodes);
        const transferEventsInPool = filterByPool(allTransferNodes);
        const unshieldEventsInPool = filterByPool(allUnshieldNodes);

        console.log(`[${cachedData ? 'INCREMENTAL' : 'FULL'} SCAN] NEW filtered shield events:`, shieldEventsInPool.length);
        console.log(`[${cachedData ? 'INCREMENTAL' : 'FULL'} SCAN] NEW filtered transfer events:`, transferEventsInPool.length);
        console.log(`[${cachedData ? 'INCREMENTAL' : 'FULL'} SCAN] NEW filtered unshield events:`, unshieldEventsInPool.length);

        if (cachedData) {
          console.log('[CACHE] Cached notes:', cachedData.ownedNotes.length);
          console.log('[CACHE] Cached commitments:', cachedData.allCommitments.length);
        }

        // Count total output notes from all transfer events
        const transferOutputNotesCount = transferEventsInPool.reduce((sum, node) => {
          const output_notes = (node.contents?.json as any)?.output_notes || [];
          return sum + output_notes.length;
        }, 0);

        console.log('[DEBUG] Starting nullifier count query...');

        // Query nullifier count from the pool's NullifierRegistry dynamic fields
        let nullifierCount = 0;
        let usedFallback = false;

        try {
          console.log('[DEBUG] Querying pool data for nullifiers registry ID...');
          const nullifierQuery = await withTimeout(
            client.query({
              query: graphql(`
                query NullifierCount($poolId: SuiAddress!) {
                  object(address: $poolId) {
                    asMoveObject {
                      contents {
                        json
                      }
                      dynamicFields {
                        pageInfo {
                          hasNextPage
                        }
                        nodes {
                          name {
                            json
                          }
                        }
                      }
                    }
                  }
                }
              `),
              variables: {
                poolId: request.poolId,
              },
            }),
            30000,
            'Nullifier count query'
          );

          const poolData = nullifierQuery.data?.object?.asMoveObject?.contents?.json as any;
          const nullifiersObjectId = poolData?.nullifiers?.id;

          if (!nullifiersObjectId) {
            throw new Error('Nullifiers registry ID not found in pool data');
          }

          console.log('[DEBUG] Got nullifiers registry ID:', nullifiersObjectId);
          console.log('[DEBUG] Starting pagination of dynamic fields...');

          // Query NullifierRegistry's dynamic fields to count nullifiers
          let hasNextPage = true;
          let cursor: string | null = null;
          let pageCount = 0;

          while (hasNextPage) {
            pageCount++;
            console.log(`[DEBUG] Querying dynamic fields page ${pageCount}...`);
            const dfQuery: any = await withTimeout(
              client.query({
                query: graphql(`
                  query NullifierRegistryDynamicFields($registryId: SuiAddress!, $first: Int, $after: String) {
                    object(address: $registryId) {
                      dynamicFields(first: $first, after: $after) {
                        pageInfo {
                          hasNextPage
                          endCursor
                        }
                        nodes {
                          name {
                            type {
                              repr
                            }
                            json
                          }
                        }
                      }
                    }
                  }
                `),
                variables: {
                  registryId: nullifiersObjectId,
                  first: 50,
                  after: cursor,
                },
              }),
              30000,
              'Nullifier registry dynamic fields query'
            );

            const nodes = dfQuery.data?.object?.dynamicFields?.nodes || [];

            // Filter for vector<u8> keys (nullifiers)
            const nullifierNodes = nodes.filter((node: any) => {
              const typeName = node.name?.type?.repr || '';
              return typeName.includes('vector<u8>');
            });

            nullifierCount += nullifierNodes.length;
            console.log(`[DEBUG] Page ${pageCount}: found ${nullifierNodes.length} nullifiers (total: ${nullifierCount})`);

            hasNextPage = dfQuery.data?.object?.dynamicFields?.pageInfo?.hasNextPage || false;
            cursor = dfQuery.data?.object?.dynamicFields?.pageInfo?.endCursor || null;

            console.log(`[DEBUG] hasNextPage: ${hasNextPage}, cursor: ${cursor?.slice(0, 20)}...`);

            if (nullifierCount >= 1000) {
              console.log('[DEBUG] Reached 1000 nullifier limit, breaking');
              break;
            }
          }
          console.log(`[DEBUG] Dynamic fields pagination complete. Total nullifiers: ${nullifierCount}`);
        } catch (err) {
          // Comprehensive fallback: count all spending events
          console.log('[DEBUG] Nullifier query failed, using fallback event-based counting. Error:', err);
          usedFallback = true;

          // Count from unshield events (1 nullifier each)
          const spentFromUnshield = unshieldEventsInPool.length;

          // Count from transfer events - parse actual input_nullifiers count
          let spentFromTransfer = 0;
          for (const transferEvent of transferEventsInPool) {
            const inputNullifiers = (transferEvent.contents?.json as any)?.input_nullifiers || [];
            // Filter out zero nullifiers (dummy inputs)
            const nonZeroNullifiers = inputNullifiers.filter((n: any) => {
              if (Array.isArray(n)) {
                return n.some(byte => byte !== 0);
              }
              return n !== null && n !== undefined;
            });
            spentFromTransfer += nonZeroNullifiers.length;
          }

          // Note: swap events would also consume 2 nullifiers each
          // const spentFromSwap = swapEventsInPool.length * 2;

          nullifierCount = spentFromUnshield + spentFromTransfer;
        }

        console.log('[DEBUG] Nullifier count complete:', nullifierCount, usedFallback ? '(fallback)' : '(from GraphQL)');

        // Always calculate event-based count for comparison/verification
        let eventBasedNullifierCount = unshieldEventsInPool.length;

        for (const transferEvent of transferEventsInPool) {
          const eventData = transferEvent.contents?.json as any;
          const inputNullifiers = eventData?.input_nullifiers || [];

          // Filter out zero nullifiers (dummy inputs)
          const nonZeroNullifiers = inputNullifiers.filter((n: any) => {
            if (Array.isArray(n)) {
              const hasNonZero = n.some(byte => byte !== 0);
              return hasNonZero;
            }
            return n !== null && n !== undefined;
          });

          eventBasedNullifierCount += nonZeroNullifiers.length;
        }

        // If GraphQL returned 0 but we have spending events, use event-based count
        if (!usedFallback && nullifierCount === 0 && eventBasedNullifierCount > 0) {
          console.log('[DEBUG] GraphQL returned 0 but events suggest', eventBasedNullifierCount, 'nullifiers. Using event-based count.');
          nullifierCount = eventBasedNullifierCount;
          usedFallback = true;
        }

        console.log('[DEBUG] Calculating total notes in pool...');
        const totalNotesInPool = shieldEventsInPool.length + transferOutputNotesCount - nullifierCount;
        console.log('[DEBUG] Total notes:', totalNotesInPool, '(shields:', shieldEventsInPool.length, '+ transfer outputs:', transferOutputNotesCount, '- nullifiers:', nullifierCount, ')');

        // Validation and sanity checks
        const totalCommitments = shieldEventsInPool.length + transferOutputNotesCount;
        if (nullifierCount > totalCommitments) {
          postMessage({
            type: "progress",
            id: request.id,
            current: 30,
            total: 100,
            message: `Warning: Spent nullifiers (${nullifierCount}) exceeds total commitments (${totalCommitments})`,
          } as WorkerResponse);
        }

        if (totalNotesInPool < 0) {
          postMessage({
            type: "progress",
            id: request.id,
            current: 30,
            total: 100,
            message: `Error: Invalid pool state - negative note count! shields=${shieldEventsInPool.length}, transferOutputs=${transferOutputNotesCount}, nullifiers=${nullifierCount}`,
          } as WorkerResponse);
        }

        postMessage({
          type: "progress",
          id: request.id,
          current: 30,
          total: 100,
          message: `Found ${allShieldNodes.length + allTransferNodes.length} events, decrypting notes... (Pool: ${shieldEventsInPool.length} shields + ${transferOutputNotesCount} transfer outputs - ${nullifierCount} spent${usedFallback ? ' [fallback]' : ''} = ${totalNotesInPool} notes)`,
          totalNotesInPool,
        } as WorkerResponse);

        // Helper to decode encrypted note bytes
        const decodeEncryptedNote = (encryptedNote: string | number[]): number[] | null => {
          if (typeof encryptedNote === 'string') {
            return decodeBase64(encryptedNote);
          } else if (Array.isArray(encryptedNote)) {
            return encryptedNote;
          }
          return null;
        };

        // Helper to parse commitment
        const parseCommitment = (commitment: string | number[]): bigint => {
          const commitmentBytes = typeof commitment === 'string'
            ? Array.from(Buffer.from(commitment, 'base64'))
            : commitment;
          return bytesToBigIntLE_BN254(commitmentBytes);
        };

        let shieldNotesDecrypted = 0;
        let transferNotesDecrypted = 0;

        console.log('[DEBUG] Starting Shield event decryption. Total shield nodes:', allShieldNodes.length);

        // Process Shield events
        for (const node of allShieldNodes) {
          const eventData = node.contents?.json as any;
          if (!eventData || (eventData.pool_id && eventData.pool_id !== request.poolId)) {
            continue;
          }

          // ALWAYS collect commitment first (Merkle tree needs ALL commitments, not just ours)
          try {
            allCommitments.push({
              commitment: parseCommitment(eventData.commitment),
              leafIndex: Number(eventData.position),
            });
          } catch (err) {
            throw new Error(`Failed to parse commitment at position ${eventData.position}: ${err instanceof Error ? err.message : err}`);
          }

          // Then check if note belongs to us (for ownedNotes only)
          const encryptedNoteBytes = decodeEncryptedNote(eventData.encrypted_note);
          if (!encryptedNoteBytes) continue;

          // Fast filtering: skip full decryption if viewing tag doesn't match (all notes use v2 format with tag)
          if (!quickCheckNote(encryptedNoteBytes, BigInt(request.spendingKey))) {
            continue; // Tag doesn't match, skip decryption (but commitment already collected)
          }

          const note = decryptNote(
            encryptedNoteBytes,
            BigInt(request.spendingKey),
            BigInt(request.masterPublicKey)
          );

          if (note) {
            shieldNotesDecrypted++;
            const leafIndex = Number(eventData.position);

            ownedNotes.push({
              note,
              leafIndex,
              nullifier: computeNullifier(BigInt(request.nullifyingKey), leafIndex),
              txDigest: (node.transaction as any)?.digest || "",
            });
          }
        }

        console.log('[DEBUG] Shield event processing complete. Decrypted:', shieldNotesDecrypted);
        console.log('[DEBUG] Starting Transfer event decryption. Total transfer nodes:', allTransferNodes.length);

        // Process Transfer events
        for (const node of allTransferNodes) {
          const eventData = node.contents?.json as any;
          if (!eventData || (eventData.pool_id && eventData.pool_id !== request.poolId)) {
            continue;
          }

          const { output_notes, output_positions, output_commitments } = eventData;

          for (let i = 0; i < output_notes.length; i++) {
            // ALWAYS collect commitment first (Merkle tree needs ALL commitments, not just ours)
            try {
              allCommitments.push({
                commitment: parseCommitment(output_commitments[i]),
                leafIndex: Number(output_positions[i]),
              });
            } catch (err) {
              throw new Error(`Failed to parse transfer commitment at index ${i}: ${err instanceof Error ? err.message : err}`);
            }

            // Then check if note belongs to us (for ownedNotes only)
            const outputNoteBytes = decodeEncryptedNote(output_notes[i]);
            if (!outputNoteBytes) continue;

            // Fast filtering: skip full decryption if viewing tag doesn't match (all notes use v2 format with tag)
            if (!quickCheckNote(outputNoteBytes, BigInt(request.spendingKey))) {
              continue; // Tag doesn't match, skip decryption (but commitment already collected)
            }

            const note = decryptNote(
              outputNoteBytes,
              BigInt(request.spendingKey),
              BigInt(request.masterPublicKey)
            );

            if (note) {
              transferNotesDecrypted++;
              const leafIndex = Number(output_positions[i]);

              ownedNotes.push({
                note,
                leafIndex,
                nullifier: computeNullifier(BigInt(request.nullifyingKey), leafIndex),
                txDigest: (node.transaction as any)?.digest || "",
              });
            }
          }
        }

        console.log('[DEBUG] Transfer event processing complete. Decrypted:', transferNotesDecrypted);
        const totalNotesDecrypted = shieldNotesDecrypted + transferNotesDecrypted;
        console.log('[DEBUG] Total notes decrypted (new):', totalNotesDecrypted);

        // Merge with cached data if cache exists
        if (cachedData) {
          console.log('[DEBUG] Merging with cached data...');
          // Add cached notes (prepend to maintain order)
          const cachedNotes = cachedData.ownedNotes.map(cachedNote => ({
            note: cachedNote.note,
            leafIndex: cachedNote.leafIndex,
            nullifier: cachedNote.nullifier,
            txDigest: cachedNote.txDigest,
          }));
          ownedNotes.unshift(...cachedNotes);

          // Add cached commitments
          for (const cachedCommitment of cachedData.allCommitments) {
            allCommitments.push({
              commitment: BigInt(cachedCommitment.commitment),
              leafIndex: cachedCommitment.leafIndex,
            });
          }
          console.log('[DEBUG] Cache merge complete. Total owned notes:', ownedNotes.length);
        }

        // Sort commitments for consistent tree building later
        if (allCommitments.length > 0) {
          allCommitments.sort((a, b) => a.leafIndex - b.leafIndex);
        }
        postMessage({
          type: "progress",
          id: request.id,
          current: 100,
          total: 100,
          message: `Scan complete! Found ${ownedNotes.length} notes.`,
        } as WorkerResponse);

        console.log('[DEBUG] Saving to cache...');
        // Save to cache
        const scanDuration = Date.now() - scanStartTime;
        await saveScanCache({
          userKey: cacheKey,
          poolId: request.poolId,
          lastScannedCursor: finalEndCursor,
          lastScannedTimestamp: Date.now(),
          ownedNotes: ownedNotes.map(n => ({
            note: n.note,
            leafIndex: n.leafIndex,
            nullifier: n.nullifier,
            txDigest: n.txDigest,
          })),
          allCommitments: allCommitments.map(c => ({
            commitment: c.commitment.toString(),
            leafIndex: c.leafIndex,
          })),
          totalNotesInPool,
          lastScanDuration: scanDuration,
        });

        console.log('[DEBUG] Cache save complete. Scan duration:', scanDuration, 'ms');
        console.log('[DEBUG] Sending final response with', ownedNotes.length, 'notes');

        const response: WorkerResponse = {
          type: "scan_notes_result",
          id: request.id,
          notes: ownedNotes,
          totalNotesInPool, // Total notes in pool = Shield - Unshield
        };
        postMessage(response);
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

        console.log('[Worker] build_merkle_tree request received. Commitments count:', request.commitments.length);
        const startBuild = Date.now();

        const tree = new ClientMerkleTree();

        console.log('[Worker] Inserting commitments into tree...');
        for (const { commitment, leafIndex } of request.commitments) {
          tree.insert(leafIndex, BigInt(commitment));
        }
        console.log('[Worker] All commitments inserted in', Date.now() - startBuild, 'ms');

        const treeId = request.id;
        merkleTreeCache.set(treeId, tree);

        console.log('[Worker] Computing root...');
        const root = tree.getRoot().toString();
        console.log('[Worker] Tree built. Root:', root.slice(0, 20) + '...');

        const response: WorkerResponse = {
          type: "build_merkle_tree_result",
          id: request.id,
          treeId,
          root,
        };
        console.log('[Worker] Sending build_merkle_tree_result response...');
        postMessage(response);
        console.log('[Worker] Response sent successfully');
        break;
      }

      case "count_pool_notes": {
        const client = new SuiGraphQLClient({ url: request.graphqlUrl });

        const [shieldResult, transferResult, unshieldResult] = await Promise.all([
          queryAllEvents(client, `${request.packageId}::pool::ShieldEvent`, 'ShieldEvents'),
          queryAllEvents(client, `${request.packageId}::pool::TransferEvent`, 'TransferEvents'),
          queryAllEvents(client, `${request.packageId}::pool::UnshieldEvent`, 'UnshieldEvents'),
        ]);

        const shieldNodes = shieldResult.nodes;
        const transferNodes = transferResult.nodes;
        const unshieldNodes = unshieldResult.nodes;

        const filterByPool = (nodes: any[]) =>
          nodes.filter(node => (node.contents?.json as any)?.pool_id === request.poolId);

        const shieldEventsInPool = filterByPool(shieldNodes);
        const transferEventsInPool = filterByPool(transferNodes);
        const unshieldEventsInPool = filterByPool(unshieldNodes);

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

        const totalNotesInPool = shieldEventsInPool.length + transferOutputNotesCount - nullifierCount;

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

        console.log('[Worker] get_merkle_proof request received. TreeId:', request.treeId, 'LeafIndex:', request.leafIndex);

        const tree = merkleTreeCache.get(request.treeId);
        if (!tree) {
          console.error('[Worker] Tree not found in cache:', request.treeId);
          throw new Error(`Tree ${request.treeId} not found`);
        }

        console.log('[Worker] Generating Merkle proof...');
        const startProof = Date.now();
        const pathElements = tree.getMerkleProof(request.leafIndex);
        console.log('[Worker] Proof generated in', Date.now() - startProof, 'ms. Path length:', pathElements.length);

        const response: WorkerResponse = {
          type: "get_merkle_proof_result",
          id: request.id,
          pathElements: pathElements.map((p) => p.toString()),
        };
        console.log('[Worker] Sending get_merkle_proof_result response...');
        postMessage(response);
        console.log('[Worker] Response sent successfully');
        break;
      }

      case "get_commitments": {
        try {
          console.log('[Worker] get_commitments request received. userKey:', request.userKey, 'poolId:', request.poolId);
          console.log('[Worker] Loading scan cache...');
          const startLoad = Date.now();
          const cache = await loadScanCache(request.userKey, request.poolId);
          console.log('[Worker] Cache loaded in', Date.now() - startLoad, 'ms. Cache exists:', !!cache);

          if (!cache) {
            throw new Error("No scan cache found. Please refresh your notes first.");
          }

          const commitments = cache.allCommitments ?? [];
          console.log('[Worker] Commitments in cache:', commitments.length);

          if (commitments.length === 0) {
            throw new Error("No commitments in cache. Please refresh your notes.");
          }

          console.log('[Worker] Sending get_commitments_result response...');
          const response: WorkerResponse = {
            type: "get_commitments_result",
            id: request.id,
            commitments,
          };
          postMessage(response);
          console.log('[Worker] Response sent successfully');
        } catch (err) {
          console.error('[Worker] get_commitments error:', err);
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