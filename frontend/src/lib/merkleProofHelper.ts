import type { OwnedNote } from "@/hooks/useNotes";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import { fetchMerkleProofs } from "@/lib/merkleProofFetcher";

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
