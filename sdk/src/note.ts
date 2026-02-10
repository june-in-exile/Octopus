/**
 * Octopus SDK - Note Utilities
 *
 * Note selection.
 */

import type { Note } from "./types.js";

/**
 * Note with metadata for selection
 */
export interface SelectableNote {
    note: Note;
    leafIndex: number;
    pathElements?: bigint[];
}

/**
 * Select notes to cover the required amount.
 *
 * Strategy:
 * 1. Try to find a single note >= amount (minimize inputs)
 * 2. If not found, try two notes (minimize total value to reduce change)
 * 3. If still not enough, throw error
 *
 * This function is used for transfers, unshields, and swaps.
 *
 * @param availableNotes - List of unspent notes owned by user
 * @param amount - Amount required
 * @returns Selected notes (1 or 2)
 */
export function selectNotes(
    availableNotes: SelectableNote[],
    amount: bigint
): SelectableNote[] {
    // Filter notes with non-zero value
    const validNotes = availableNotes.filter((n) => n.note.value > 0n);

    if (validNotes.length === 0) {
        throw new Error("No notes available");
    }

    if (amount <= 0n) {
        throw new Error("Transfer amount must be greater than 0");
    }

    // Strategy 1: Try single note (most efficient)
    const singleNote = validNotes.find((n) => n.note.value >= amount);
    if (singleNote) {
        return [singleNote];
    }

    // Strategy 2: Try two notes (minimize total value to reduce change)
    // Sort by value ascending
    const sorted = [...validNotes].sort((a, b) => {
        if (a.note.value < b.note.value) return -1;
        if (a.note.value > b.note.value) return 1;
        return 0;
    });

    // Find the smallest pair that covers the amount
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            const total = sorted[i].note.value + sorted[j].note.value;
            if (total >= amount) {
                return [sorted[i], sorted[j]];
            }
        }
    }

    // Calculate total available balance
    const totalBalance = validNotes.reduce((sum, n) => sum + n.note.value, 0n);

    // Check if the issue is circuit limitation or actual insufficient balance
    if (totalBalance >= amount) {
        throw new Error(
            `Cannot select notes for transfer. The circuit supports maximum 2 input notes, ` +
            `but your amount (${amount}) requires 3 or more notes. ` +
            `Available balance: ${totalBalance} across ${validNotes.length} notes. ` +
            `Solution: Consolidate your notes first by doing smaller transfers, or wait for multi-input circuit support.`
        );
    }

    throw new Error(
        `Insufficient balance for transfer. Required: ${amount}, Available: ${totalBalance}`
    );
}