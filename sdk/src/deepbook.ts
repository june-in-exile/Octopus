import { SuiClient } from "@mysten/sui/client";

/**
 * Swap estimation result
 */
export interface SwapEstimation {
  amountOut: bigint;
  priceImpact: number;
  effectivePrice: number;
  feeAmount: bigint;
}

/**
 * Estimate swap output from DeepBook order book
 *
 * Note: This is a simplified estimation. In production, this should query
 * the actual order book depth and walk through orders to get accurate pricing.
 *
 * @param client - Sui client instance
 * @param poolId - DeepBook pool object ID
 * @param amountIn - Input amount in smallest units
 * @param isBid - true if buying base with quote, false if selling base for quote
 * @returns Swap estimation with output amount, price impact, and fees
 */
export async function estimateDeepBookSwap(
  client: SuiClient,
  poolId: string,
  amountIn: bigint,
  isBid: boolean
): Promise<SwapEstimation> {
  // Calculate 0.25% taker fee (25 basis points)
  const feeAmount = (amountIn * 25n) / 10000n;
  const amountInAfterFee = amountIn - feeAmount;

  // Simplified estimation (query order book in production)
  // Mock: 1 SUI = 3 USDC for testnet
  // In production, this should query actual order book and walk through orders
  let amountOut: bigint;
  if (isBid) {
    // Buying base (SUI) with quote (USDC): divide by 3
    amountOut = amountInAfterFee / 3n;
  } else {
    // Selling base (SUI) for quote (USDC): multiply by 3
    amountOut = amountInAfterFee * 3n;
  }

  const effectivePrice = Number(amountOut) / Number(amountIn);
  const priceImpact = 0.1; // Mock ~0.1% for testnet

  return {
    amountOut,
    priceImpact,
    effectivePrice,
    feeAmount,
  };
}