import {
  createNote,
  randomFieldElement,
  poseidonHash,
  type SwapParams,
  type SwapInput,
} from "@june_zk/octopus-sdk";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import type { OwnedNote } from "@/hooks/useNotes";

/**
 * Derive token ID from coin type (matches shield operation logic)
 */
export function deriveTokenIdFromCoinType(coinType: string): bigint {
  const packageAddr = coinType.split("::")[0];
  return poseidonHash([BigInt(packageAddr)]);
}

/**
 * Build swap input for proof generation
 */
export function buildSwapInput(
  keypair: OctopusKeypair,
  notesWithProofs: OwnedNote[],
  swapParams: SwapParams,
  outputTokenId: bigint,
  amountOut: bigint
): { swapInput: SwapInput; outputNote: any; changeNote: any } {
  const inputTokenId = notesWithProofs[0].note.token;
  const totalInputValue = notesWithProofs.reduce(
    (sum, n) => sum + n.note.amount,
    0n
  );

  // Create output note (swapped tokens for recipient - self)
  const outputRandom = randomFieldElement();
  const outputNote = createNote(
    keypair.masterPublicKey,
    outputTokenId,
    amountOut,
    outputRandom
  );

  // Create change note (remaining input tokens)
  const changeAmount = totalInputValue - swapParams.amountIn;
  const changeRandom = randomFieldElement();
  const changeNote = createNote(
    keypair.masterPublicKey,
    inputTokenId,
    changeAmount,
    changeRandom
  );

  const swapInput: SwapInput = {
    keypair,
    inputNotes: notesWithProofs.map((n) => n.note),
    inputLeafIndices: notesWithProofs.map((n) => n.leafIndex),
    inputPathElements: notesWithProofs.map((n) => n.pathElements!),
    swapParams,
    outputNSK: outputNote.nsk,
    outputRandom: outputNote.random,
    outputAmount: outputNote.amount,
    changeNSK: changeNote.nsk,
    changeRandom: changeNote.random,
    changeAmount: changeNote.amount,
  };

  return { swapInput, outputNote, changeNote };
}

/**
 * Validate sufficient balance before expensive operations
 */
export function validateSufficientBalance(
  notes: OwnedNote[],
  requiredAmount: bigint,
  tokenSymbol: string
): void {
  const unspentNotes = notes.filter((n) => !n.spent);
  const totalBalance = unspentNotes.reduce((sum, n) => sum + n.note.amount, 0n);

  if (totalBalance < requiredAmount) {
    throw new Error(
      `Insufficient shielded balance. You need ${requiredAmount} ${tokenSymbol} but only have ` +
      `${totalBalance} ${tokenSymbol} available. Please shield more tokens first.`
    );
  }
}

/**
 * Check if notes cache is stale and warn user
 */
export function checkCacheStaleness(
  lastScanStats: { eventsScanned: number; notesDecrypted: number; timestamp: number } | null | undefined
): void {
  const STALENESS_WARNING_MS = 5 * 60 * 1000; // 5 minutes

  if (lastScanStats) {
    const cacheAge = Date.now() - lastScanStats.timestamp;
    if (cacheAge > STALENESS_WARNING_MS) {
      const ageMinutes = Math.floor(cacheAge / 60000);
      console.warn(
        `⚠️ Notes cache is ${ageMinutes} minutes old. Consider refreshing before swap.`
      );
    }
  }
}
