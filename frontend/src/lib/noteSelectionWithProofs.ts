import type { OwnedNote } from "@/hooks/useNotes";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import { selectAndPrepareNotes } from "@/lib/noteSelection";
import { fetchAndAttachMerkleProofs } from "@/lib/merkleProofHelper";

/**
 * Select notes to cover amount, fetch Merkle proofs, and mark as spent.
 *
 * This is a common pattern across Transfer, Unshield, and Swap operations.
 *
 * @param notes - All available notes
 * @param amount - Amount to cover (in smallest units)
 * @param keypair - User's Octopus keypair
 * @param poolId - Pool ID for fetching Merkle proofs
 * @param markNoteSpent - Optional callback to mark notes as spent locally
 * @returns Selected notes with attached Merkle proofs
 */
export async function selectNotesWithProofs(
  notes: OwnedNote[],
  amount: bigint,
  keypair: OctopusKeypair,
  poolId: string,
  markNoteSpent?: (nullifier: bigint) => void
): Promise<OwnedNote[]> {
  // 1. Select notes to cover amount
  const selectedOwnedNotes = selectAndPrepareNotes(notes, amount);

  // 2. Fetch Merkle proofs for selected notes
  const notesWithProofs = await fetchAndAttachMerkleProofs(
    selectedOwnedNotes,
    keypair,
    poolId
  );

  // 3. Mark notes as spent before generating proof
  selectedOwnedNotes.forEach((ownedNote) => {
    markNoteSpent?.(ownedNote.nullifier);
  });

  return notesWithProofs;
}
