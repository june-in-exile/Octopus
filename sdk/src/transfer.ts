/**
 * Octopus SDK - Transfer Utilities
 *
 * Output notes creation for private transfers.
 */

import type { Note } from "./types.js";
import { createNote } from "./crypto.js";

/**
 * Create output notes for transfer (recipient + change).
 *
 * @param recipientMpk - Recipient's master public key
 * @param senderMpk - Sender's master public key (for change note)
 * @param amount - Amount to send to recipient
 * @param inputTotal - Sum of input note anounts
 * @param token - Token type identifier
 * @returns Array of 2 output notes [recipient, change]
 */
export function createTransferOutputs(
  recipientMpk: bigint,
  senderMpk: bigint,
  amount: bigint,
  inputTotal: bigint,
  token: bigint
): [Note, Note] {
  if (amount > inputTotal) {
    throw new Error(
      `Amount (${amount}) exceeds input total (${inputTotal})`
    );
  }

  // Recipient note
  const recipientNote = createNote(recipientMpk, token, amount);

  // Change note (back to sender)
  const changeAmount = inputTotal - amount;
  const changeNote = createNote(senderMpk, token, changeAmount);

  return [recipientNote, changeNote];
}