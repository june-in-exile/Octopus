/**
 * Lazy Merkle Proof Fetcher
 *
 * Provides on-demand Merkle proof generation for transaction forms.
 * Fetches cached commitments and builds the tree only when proofs are needed.
 */

import type { OwnedNote } from "@/hooks/useNotes";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import { getWorkerManager } from "./workerManager";
import { generateCacheKey } from "./notesCache";

/**
 * Fetch Merkle proofs on-demand for selected notes.
 * Uses cached commitments from the last scan to build the tree.
 *
 * @param spendingKey - User's spending key
 * @param poolId - Pool ID
 * @param leafIndices - Leaf indices of notes to generate proofs for
 * @returns Map of leaf index to path elements (Merkle proof)
 * @throws Error if cached commitments are unavailable
 */
async function fetchMerkleProofs(
  spendingKey: bigint,
  poolId: string,
  leafIndices: number[]
): Promise<Map<number, bigint[]>> {
  try {
    const worker = getWorkerManager();

    const cacheKey = await generateCacheKey(spendingKey.toString());

    // 1. Get cached commitments
    const commitments = await worker.getCommitmentsFromCache(cacheKey, poolId);

    if (!commitments || commitments.length === 0) {
      throw new Error(
        "No commitment data available. Please refresh your notes first."
      );
    }

    // Validate that all required leaf indices exist in the cache
    const maxLeafIndex = Math.max(...commitments.map(c => c.leafIndex));
    const minLeafIndex = Math.min(...commitments.map(c => c.leafIndex));
    const missingIndices = leafIndices.filter(idx =>
      idx < minLeafIndex || idx > maxLeafIndex ||
      !commitments.some(c => c.leafIndex === idx)
    );

    if (missingIndices.length > 0) {
      throw new Error(
        `Stale cache detected! Your notes are outdated. Missing commitments for leaf indices: ${missingIndices.join(', ')}. ` +
        `Cache has commitments ${minLeafIndex}-${maxLeafIndex}, but you need ${leafIndices.join(', ')}. ` +
        `Please click "Refresh Notes" to sync with the latest on-chain state.`
      );
    }

    // 2. Build tree and get proofs for selected notes only
    const startProof = Date.now();
    const proofs = await worker.generateMerkleProofs(leafIndices, commitments);

    return proofs;
  } catch (error) {
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

export async function fetchAndAttachMerkleProofs(
  selectedNotes: OwnedNote[],
  keypair: OctopusKeypair,
  poolId: string
): Promise<OwnedNote[]> {
  const leafIndices = selectedNotes.map(n => n.leafIndex);

  const merkleProofs = await fetchMerkleProofs(
    keypair.spendingKey,
    poolId,
    leafIndices
  );

  return selectedNotes.map(n => {
    const pathElements = merkleProofs.get(n.leafIndex);
    if (!pathElements || pathElements.length === 0) {
      throw new Error(`Failed to generate Merkle proof for note at leaf index ${n.leafIndex}`);
    }
    return { ...n, pathElements };
  });
}
