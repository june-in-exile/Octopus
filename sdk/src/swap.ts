/**
 * Octopus SDK - Swap Utilities
 *
 * Output notes creation for private swapping.
 */

import type { Note } from "./types.js";
import { createNote } from "./crypto.js";

/**
 * Create output notes for swap (swap output + change).
 *
 * @param mpk - Master public key
 * @param amountIn - Amount to swap in
 * @param minAmountOut - Minimum guaranteed output amount (slippage-adjusted, committed to ZKP)
 * @param inputTotal - Sum of input note amounts
 * @param tokenIn - Token type identifier for change note
 * @param tokenOut - Token type identifier for output note
 * @returns Array of 2 output notes [swap, change]
 */
export function createSwapOutputs(
    mpk: bigint,
    amountIn: bigint,
    minAmountOut: bigint,
    inputTotal: bigint,
    tokenIn: bigint,
    tokenOut: bigint,
): [Note, Note] {
    if (amountIn > inputTotal) {
        throw new Error(
            `Amount (${amountIn}) exceeds input total (${inputTotal})`
        );
    }

    // Output note commits to min_amount_out (slippage-protected minimum)
    const swapNote = createNote(
        mpk,
        tokenOut,
        minAmountOut
    );

    // Change note (remaining input tokens)
    const changeAmount = inputTotal - amountIn;
    const changeNote = createNote(
        mpk,
        tokenIn,
        changeAmount,
    );

    return [swapNote, changeNote];
}