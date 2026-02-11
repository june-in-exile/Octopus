/**
 * Octopus SDK - Unshield Utilities
 *
 * Output notes creation for unshield.
 */

import type { Note } from "./types.js";
import { createNote } from "./crypto.js";

/**
 * Create output notes for transfer (recipient + change).
 *
 * @param mpk - Master public key (for change note)
 * @param amount - Amount to unshield
 * @param inputTotal - Sum of input note anounts
 * @param token - Token type identifier
 * @returns change note
 */
export function createUnshieldOutputs(
    mpk: bigint,
    amount: bigint,
    inputTotal: bigint,
    token: bigint
): Note {
    if (amount > inputTotal) {
        throw new Error(
            `Amount (${amount}) exceeds input total (${inputTotal})`
        );
    }

    // Change note
    const changeAmount = inputTotal - amount;
    const changeNote = createNote(mpk, token, changeAmount);

    return changeNote;
}