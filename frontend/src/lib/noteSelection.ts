import type { OwnedNote } from "@/hooks/useNotes";
import { selectNotes, type SelectableNote } from "@june_zk/octopus-sdk";

export function selectAndPrepareNotes(
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
