/**
 * Lazy Merkle Proof Fetcher
 *
 * Provides on-demand Merkle proof generation for transaction forms.
 * Fetches cached commitments and builds the tree only when proofs are needed.
 */

import { getWorkerManager } from "./workerManager";
import { generateCacheKey } from "./notesCache";

/**
 * Fetch Merkle proofs on-demand for selected notes.
 * Uses cached commitments from the last scan to build the tree.
 *
 * @param spendingKey - User's spending key
 * @param poolId - Pool ID
 * @param selectedLeafIndices - Leaf indices of notes to generate proofs for
 * @returns Map of leaf index to path elements (Merkle proof)
 * @throws Error if cached commitments are unavailable
 */
export async function fetchMerkleProofs(
  spendingKey: bigint,
  poolId: string,
  selectedLeafIndices: number[]
): Promise<Map<number, bigint[]>> {
  console.log('[fetchMerkleProofs] Starting...', {
    poolId,
    selectedLeafIndices,
  });

  try {
    console.log('[fetchMerkleProofs] Getting worker manager...');
    const worker = getWorkerManager();

    console.log('[fetchMerkleProofs] Generating cache key...');
    const cacheKey = await generateCacheKey(spendingKey.toString());
    console.log('[fetchMerkleProofs] Cache key generated:', cacheKey);

    // 1. Get cached commitments
    console.log('[fetchMerkleProofs] Fetching cached commitments...');
    const startFetch = Date.now();
    const commitments = await worker.getCommitmentsFromCache(cacheKey, poolId);
    console.log('[fetchMerkleProofs] Commitments fetched in', Date.now() - startFetch, 'ms. Count:', commitments?.length ?? 0);

    if (!commitments || commitments.length === 0) {
      throw new Error(
        "No commitment data available. Please refresh your notes first."
      );
    }

    // Validate that all required leaf indices exist in the cache
    const maxLeafIndex = Math.max(...commitments.map(c => c.leafIndex));
    const minLeafIndex = Math.min(...commitments.map(c => c.leafIndex));
    const missingIndices = selectedLeafIndices.filter(idx =>
      idx < minLeafIndex || idx > maxLeafIndex ||
      !commitments.some(c => c.leafIndex === idx)
    );

    if (missingIndices.length > 0) {
      console.error('[fetchMerkleProofs] Missing commitments for leaf indices:', missingIndices);
      console.error('[fetchMerkleProofs] Cache range:', minLeafIndex, 'to', maxLeafIndex);
      throw new Error(
        `Stale cache detected! Your notes are outdated. Missing commitments for leaf indices: ${missingIndices.join(', ')}. ` +
        `Cache has commitments ${minLeafIndex}-${maxLeafIndex}, but you need ${selectedLeafIndices.join(', ')}. ` +
        `Please click "Refresh Notes" to sync with the latest on-chain state.`
      );
    }

    // 2. Build tree and get proofs for selected notes only
    console.log('[fetchMerkleProofs] Building Merkle tree and generating proofs...');
    const startProof = Date.now();
    const proofs = await worker.generateMerkleProofs(selectedLeafIndices, commitments);
    console.log('[fetchMerkleProofs] Proofs generated in', Date.now() - startProof, 'ms');

    console.log('[fetchMerkleProofs] Complete! Generated', proofs.size, 'proofs');
    return proofs;
  } catch (error) {
    console.error('[fetchMerkleProofs] Error:', error);
    if (error instanceof Error) {
      if (error.message.includes("timeout")) {
        throw new Error(
          "Merkle proof generation timed out. This can happen with large note pools. " +
          "Please try again or contact support if the issue persists."
        );
      }
    }
    throw error;
  }
}
