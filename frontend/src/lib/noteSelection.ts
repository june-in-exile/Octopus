import type { OwnedNote } from "@/hooks/useNotes";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import { fetchAndAttachMerkleProofs } from "@/lib/merkleProofFetcher";
import { selectNotes, type SelectableNote } from "@june_zk/octopus-sdk";

function selectAndPrepareNotes(
  notes: OwnedNote[],
  amountMist: bigint
): OwnedNote[] {
  // 1. Get unspent notes
  const unspentNotes = notes.filter((n: OwnedNote) => !n.spent);
  if (unspentNotes.length === 0) {
    throw new Error("No unspent notes available. Shield some tokens first!");
  }

  // 2. Select notes to cover amount
  const selectableNotes: SelectableNote[] = unspentNotes.map(n => ({
    note: n.note,
    leafIndex: n.leafIndex,
    pathElements: n.pathElements
  }));

  const selectedNotes = selectNotes(selectableNotes, amountMist);
  if (!selectedNotes || selectedNotes.length === 0) {
    throw new Error("Insufficient balance or unable to select appropriate notes!");
  }

  // Convert back to OwnedNote[]
  return selectedNotes.map((selectedNote: SelectableNote) => {
    const ownedNote = unspentNotes.find((n) => n.leafIndex === selectedNote.leafIndex);
    if (!ownedNote) {
      throw new Error(`Could not find owned note for leafIndex ${selectedNote.leafIndex}`);
    }
    return ownedNote;
  });
}

/**
 * Select notes to cover amount and fetch Merkle proofs.
 *
 * This is a common pattern across Transfer, Unshield, and Swap operations.
 *
 * @param notes - All available notes
 * @param amount - Amount to cover (in smallest units)
 * @param keypair - User's Octopus keypair
 * @param poolId - Pool ID for fetching Merkle proofs
 * @returns Selected notes with attached Merkle proofs
 */
export async function selectNotesWithProofs(
  notes: OwnedNote[],
  amount: bigint,
  keypair: OctopusKeypair,
  poolId: string
): Promise<OwnedNote[]> {
  // 1. Select notes to cover amount
  const selectedOwnedNotes = selectAndPrepareNotes(notes, amount);

  // 2. Fetch Merkle proofs for selected notes
  const notesWithProofs = await fetchAndAttachMerkleProofs(
    selectedOwnedNotes,
    keypair,
    poolId
  );

  return notesWithProofs;
}
